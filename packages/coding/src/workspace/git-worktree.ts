import { randomUUID } from 'node:crypto'
import { mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnProcess } from '../process/spawn-process'

/**
 * Isolates a workflow run in its own git worktree instead of letting
 * executors write directly into the user's real working directory.
 *
 * Caught live: without this, an implementer's out-of-scope changes (or
 * leftovers from an earlier, separate test run sitting uncommitted) end up
 * mixed into the same working tree, and a later stage has to `git
 * checkout`/`git restore` files mid-run to claw scope back - silently
 * touching real, uncommitted work the whole time the workflow runs. A
 * worktree gives each run a clean, disposable checkout on its own branch;
 * the user's actual directory is untouched until they explicitly approve
 * merging the result (createWorktree -> run everything against
 * WorktreeInfo.path -> mergeWorktree or discardWorktree).
 */

export interface WorktreeInfo {
  /** Absolute path to the isolated worktree - use this as the workingDirectory for every stage. */
  path: string
  /** The branch created for this run, checked out in the worktree. */
  branch: string
  /** The real project directory the worktree was created from - merge/discard operate here. */
  sourceRepo: string
}

async function git(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const { child, exitCode } = spawnProcess('git', args, { cwd: cwd ?? process.cwd() })
  let stdout = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf-8')))
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf-8')))
  const code = await exitCode
  return { stdout, stderr, exitCode: code }
}

async function gitOrThrow(args: string[], cwd?: string): Promise<string> {
  const result = await git(args, cwd)
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} ist fehlgeschlagen: ${result.stderr.trim() || `Exit-Code ${result.exitCode}`}`)
  }
  return result.stdout
}

const INIT_COMMIT_MESSAGE = 'Initialize AI Council project'

/**
 * True if `repoPath`'s own root commit(s) carry AI Council's init marker -
 * i.e. this repo was itself created by ensureProjectRepository at some
 * point, not a pre-existing, unrelated repo the user already had. Used to
 * tell "nested inside a foreign project - refuse" apart from "nested inside
 * a shared workspace root that already holds other AI Council apps - fine".
 */
async function isAiCouncilManagedRepo(repoPath: string): Promise<boolean> {
  const result = await git(['log', '--format=%s', '--max-parents=0', 'HEAD'], repoPath)
  if (result.exitCode !== 0) return false
  return result.stdout.split('\n').some((line) => line.trim() === INIT_COMMIT_MESSAGE)
}

/** Prepare a new empty project without committing or hiding existing user files. */
export async function ensureProjectRepository(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('Kein Arbeitsverzeichnis angegeben.')
  const path = resolve(directory.trim())
  await gitOrThrow(['--version'])
  await mkdir(path, { recursive: true })

  const root = await git(['rev-parse', '--show-toplevel'], path)
  const isOwnToplevel = root.exitCode === 0 && (await realpath(root.stdout.trim())) === (await realpath(path))

  if (root.exitCode === 0 && !isOwnToplevel) {
    const ancestorPath = await realpath(root.stdout.trim())
    if (!(await isAiCouncilManagedRepo(ancestorPath))) {
      throw new Error(
        'Das Verzeichnis liegt innerhalb eines anderen Git-Projekts. Bitte dessen Stammverzeichnis oder einen separaten Projektordner wählen.'
      )
    }
    // The enclosing repo was itself created by AI Council (e.g. a shared
    // workspace folder holding several sibling apps) - safe to give this
    // subfolder its own, separate repo rather than refusing outright. Falls
    // through to the same empty-directory init path below; isOwnToplevel
    // stays false, so the "already initialized" shortcut is correctly
    // skipped and a fresh `git init` runs right here instead.
  }

  if (isOwnToplevel && (await git(['rev-parse', '--verify', 'HEAD'], path)).exitCode === 0) return path
  const files = (await readdir(path)).filter((name) => name !== '.git')
  if (files.length > 0) {
    throw new Error('Das Verzeichnis enthält bereits Dateien, aber noch keinen Git-Commit. Bitte die gewünschten Dateien zuerst in Git übernehmen oder einen leeren Projektordner wählen.')
  }
  if (!isOwnToplevel) await gitOrThrow(['init'], path)
  // Repository-local defaults also let later workflow commits work on a fresh machine.
  for (const [key, value] of [['user.name', 'AI Council'], ['user.email', 'ai-council@localhost']]) {
    const configured = await git(['config', '--get', key], path)
    if (!configured.stdout.trim()) await gitOrThrow(['config', '--local', key, value], path)
  }
  await gitOrThrow(['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--only', '-m', INIT_COMMIT_MESSAGE], path)
  return path
}

/**
 * Creates a new worktree for `sourceRepo` under `worktreesRoot`, on a fresh
 * branch off the repo's current HEAD. `worktreesRoot` is deliberately
 * outside the repo (the caller passes something like Electron's userData
 * dir) - nesting a worktree inside the repo it belongs to shows up as
 * stray content in `git status` of the very tree it's meant to keep clean.
 */
export async function createWorktree(sourceRepo: string, worktreesRoot: string): Promise<WorktreeInfo> {
  const id = randomUUID().slice(0, 8)
  const branch = `ai-council/${id}`
  const path = join(worktreesRoot, id)
  await gitOrThrow(['worktree', 'add', '-b', branch, path, 'HEAD'], sourceRepo)
  return { path, branch, sourceRepo }
}

/**
 * Commits whatever the workflow left uncommitted in the worktree (the
 * executors themselves never commit) and merges that branch into whichever
 * branch is currently checked out in the source repo, then removes the
 * worktree. Throws on conflict or any other git failure instead of
 * swallowing it - the caller (an explicit "Übernehmen" action the user
 * clicked) needs to know if this didn't fully succeed.
 *
 * Caught live: the source repo had its own pre-existing uncommitted local
 * changes to a file the merge also touched, so git correctly refused with
 * "local changes would be overwritten by merge" - and the worktree/branch
 * were being deleted regardless (the old cleanup ran in a `finally`
 * covering the merge attempt), permanently losing the reviewed changes on
 * the very first failed merge. Cleanup now happens only after `git merge`
 * itself succeeds - a failed merge leaves the worktree and branch exactly
 * as they were, so the user can resolve whatever blocked it (commit or
 * stash their own local changes) and retry "Übernehmen" without having
 * lost anything.
 */
export async function mergeWorktree(info: WorktreeInfo): Promise<void> {
  await gitOrThrow(['add', '-A'], info.path)
  const staged = await git(['diff', '--cached', '--quiet'], info.path)
  if (staged.exitCode !== 0) {
    await gitOrThrow(['-c', 'commit.gpgsign=false', 'commit', '-m', `AI Council: ${info.branch}`], info.path)
  }
  try {
    await gitOrThrow(['merge', '--no-edit', info.branch], info.sourceRepo)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes('would be overwritten by merge')) {
      throw new Error(
        `${message}\n\nDein Arbeitsverzeichnis (${info.sourceRepo}) hat eigene, nicht committete Änderungen an denselben Dateien. Committe oder stashe sie dort zuerst - die geprüften Änderungen bleiben bis dahin sicher im Worktree, einfach danach erneut auf "Übernehmen" klicken.`
      )
    }
    throw err
  }
  await removeWorktree(info)
}

/** Throws away the worktree and its branch without merging anything back. */
export async function discardWorktree(info: WorktreeInfo): Promise<void> {
  await removeWorktree(info)
}

async function removeWorktree(info: WorktreeInfo): Promise<void> {
  const result = await git(['worktree', 'remove', '--force', info.path], info.sourceRepo)
  if (result.exitCode !== 0) {
    // The worktree directory may already be gone/moved - fall back to a
    // plain filesystem removal plus prune so git's own bookkeeping doesn't
    // keep pointing at a dead path.
    await rm(info.path, { recursive: true, force: true })
    await git(['worktree', 'prune'], info.sourceRepo)
  }
  await git(['branch', '-D', info.branch], info.sourceRepo)
}
