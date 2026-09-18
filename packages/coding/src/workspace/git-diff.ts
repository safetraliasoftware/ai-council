import { spawnProcess } from '../process/spawn-process'

/**
 * Git-based diff capture, deliberately independent of any CodingExecutor.
 * Whether Claude Code or Codex (or a future executor) did the work, "what
 * changed in the repo" is measured the same way - this is what lets one
 * executor's output become another's review input (e.g. Codex reviewing a
 * diff Claude Code produced) without either knowing about the other.
 */

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'unknown'

export interface GitFileChange {
  path: string
  status: GitChangeStatus
}

export interface GitDiffResult {
  hasChanges: boolean
  files: GitFileChange[]
  /** Unified diff for tracked changes (committed or not) since the capture's base ref. Empty string if there is no such ref yet or no tracked changes. Untracked files appear in `files` but their content is not included here. */
  diff: string
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number | null }> {
  const { child, exitCode } = spawnProcess('git', args, { cwd })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf-8')
  })
  const code = await exitCode
  return { stdout, exitCode: code }
}

/**
 * Caught live: `git rev-parse --is-inside-work-tree` prints "true" or
 * "false" to stdout but exits 0 in BOTH cases - exit code 0 only means git
 * successfully determined an answer, not that the answer was "yes". A
 * directory inside git's own internal bookkeeping (e.g. a linked
 * worktree's `.git/worktrees/<id>` administrative folder, as opposed to
 * the worktree's actual checkout) prints "false" and still exits 0, so
 * checking only the exit code reported it as a valid repo - every git
 * command that followed then failed with "fatal: this operation must be
 * run in a work tree" (written to stderr, so stdout/the parsed result
 * stayed empty), which silently looked identical to "no changes".
 */
export async function isGitRepo(workingDirectory: string): Promise<boolean> {
  const result = await runGit(['rev-parse', '--is-inside-work-tree'], workingDirectory)
  return result.exitCode === 0 && result.stdout.trim() === 'true'
}

/**
 * Captures everything that changed relative to `baseRef` (default `HEAD`,
 * i.e. today's "just the uncommitted changes" behavior for every existing
 * caller - this parameter is purely additive): file list via `git diff
 * --name-status <baseRef>` (tracked changes, committed or not, since
 * baseRef) plus untracked files via `git status --porcelain` (git diff
 * never shows those), and a unified diff via `git diff <baseRef>`.
 *
 * Deliberately NOT `git status --porcelain` + `git diff HEAD` for the
 * tracked-file list (the original implementation): that combination is
 * blind to anything already committed since `baseRef` - see
 * project-engine.ts's `taskStartCommit`, which passes the task's starting
 * commit specifically so a scope check can't be defeated by an agent
 * committing an out-of-scope change mid-turn (caught in a self-review,
 * confirmed live: `git status` reports clean right after a commit,
 * regardless of what the commit actually touched).
 *
 * Git failures throw rather than appearing as an empty diff. NUL-delimited
 * paths preserve spaces and Unicode; renames expose both affected paths.
 */
export async function captureGitDiff(workingDirectory: string, baseRef: string = 'HEAD'): Promise<GitDiffResult> {
  // --untracked-files=all: list files inside a wholly-new directory
  // individually instead of collapsing them to "newdir/" - a reviewer (or
  // another executor) needs per-file granularity, not just "a folder appeared".
  const statusResult = await runGit(['status', '--porcelain', '-z', '--untracked-files=all'], workingDirectory)
  if (statusResult.exitCode !== 0) throw new Error('Git-Status konnte nicht gelesen werden.')
  const untrackedFiles: GitFileChange[] = []
  const entries = statusResult.stdout.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.startsWith('?? ')) untrackedFiles.push({ path: entry.slice(3), status: 'untracked' })
    if (/^[RC]|^.[RC]/.test(entry)) i++
  }
  const baseCheck = await runGit(['rev-parse', '--verify', baseRef], workingDirectory)
  const trackedFiles: GitFileChange[] = []
  let diff = ''
  if (baseCheck.exitCode === 0) {
    // Treat renames as deletion + addition: both paths must pass scope checks.
    const names = await runGit(['diff', '--no-renames', '--name-status', '-z', baseRef], workingDirectory)
    const patch = await runGit(['diff', baseRef, '--unified=3'], workingDirectory)
    if (names.exitCode !== 0 || patch.exitCode !== 0) throw new Error('Git-Diff konnte nicht gelesen werden.')
    const fields = names.stdout.split('\0')
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = ({ A: 'added', D: 'deleted', M: 'modified' } as const)[fields[i] as 'A' | 'D' | 'M'] ?? 'unknown'
      trackedFiles.push({ path: fields[i + 1], status })
    }
    diff = patch.stdout
  } else if (baseRef !== 'HEAD') {
    throw new Error('Git-Basis für den Review-Diff fehlt.')
  }
  const files = [...trackedFiles, ...untrackedFiles]
  return { hasChanges: files.length > 0, files, diff }
}
