import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnProcess } from '../process/spawn-process'
import { captureGitDiff, isGitRepo } from '../workspace/git-diff'

async function run(command: string, args: string[], cwd: string): Promise<void> {
  const { exitCode } = spawnProcess(command, args, { cwd })
  await exitCode
}

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
  const { child, exitCode } = spawnProcess(command, args, { cwd })
  let stdout = ''
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')))
  await exitCode
  return stdout.trim()
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await run('git', ['init'], dir)
  await run('git', ['config', 'user.email', 'test@example.com'], dir)
  await run('git', ['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'existing.txt'), 'original content\n')
  await run('git', ['add', '-A'], dir)
  await run('git', ['commit', '-m', 'initial'], dir)
}

// Real Git subprocesses need more than the default 5 seconds on Windows.
describe('git-diff', { timeout: 30000 }, () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'git-diff-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('isGitRepo() returns false for a plain directory', async () => {
    expect(await isGitRepo(dir)).toBe(false)
  })

  it('isGitRepo() returns true after git init', async () => {
    await run('git', ['init'], dir)
    expect(await isGitRepo(dir)).toBe(true)
  })

  it('reports no changes right after the initial commit', async () => {
    await initRepoWithCommit(dir)
    const result = await captureGitDiff(dir)
    expect(result.hasChanges).toBe(false)
    expect(result.files).toEqual([])
    expect(result.diff).toBe('')
  })

  it('detects a modified tracked file, with real diff content', async () => {
    await initRepoWithCommit(dir)
    writeFileSync(join(dir, 'existing.txt'), 'changed content\n')

    const result = await captureGitDiff(dir)
    expect(result.hasChanges).toBe(true)
    expect(result.files).toEqual([{ path: 'existing.txt', status: 'modified' }])
    expect(result.diff).toContain('-original content')
    expect(result.diff).toContain('+changed content')
  })

  it('detects a new untracked file', async () => {
    await initRepoWithCommit(dir)
    writeFileSync(join(dir, 'new-file.txt'), 'brand new\n')

    const result = await captureGitDiff(dir)
    expect(result.hasChanges).toBe(true)
    expect(result.files).toEqual([{ path: 'new-file.txt', status: 'untracked' }])
  })

  it('detects a deleted tracked file', async () => {
    await initRepoWithCommit(dir)
    rmSync(join(dir, 'existing.txt'))

    const result = await captureGitDiff(dir)
    expect(result.files).toEqual([{ path: 'existing.txt', status: 'deleted' }])
  })
  it('includes the source and destination of a rename for scope checks', async () => {
    await initRepoWithCommit(dir)
    await run('git', ['mv', 'existing.txt', 'allowed.txt'], dir)
    const result = await captureGitDiff(dir)
    expect(result.files).toEqual(expect.arrayContaining([
      { path: 'existing.txt', status: 'deleted' }, { path: 'allowed.txt', status: 'added' }
    ]))
  })
  it('preserves filenames with spaces and unicode', async () => {
    await initRepoWithCommit(dir)
    writeFileSync(join(dir, 'neue ä Datei.txt'), 'new')
    expect((await captureGitDiff(dir)).files).toContainEqual({ path: 'neue ä Datei.txt', status: 'untracked' })
    await run('git', ['add', '-A'], dir)
    expect((await captureGitDiff(dir)).files).toContainEqual({ path: 'neue ä Datei.txt', status: 'added' })
  })

  it('handles a repo with no commits yet (no HEAD) without throwing', async () => {
    await run('git', ['init'], dir)
    writeFileSync(join(dir, 'a.txt'), 'x')

    const result = await captureGitDiff(dir)
    expect(result.diff).toBe('')
    expect(result.files).toEqual([{ path: 'a.txt', status: 'untracked' }])
  })

  it('REGRESSION (false positive for a valid "no" answer): isGitRepo() returns false for git\'s own internal worktree admin folder', async () => {
    // Caught live: `git rev-parse --is-inside-work-tree` exits 0 and prints
    // "false" for a directory inside git's own bookkeeping (a linked
    // worktree's `.git/worktrees/<id>` administrative folder, as distinct
    // from that worktree's actual checkout) - checking only the exit code
    // treated exit-0-with-"false" the same as exit-0-with-"true", so this
    // path was reported as a valid repo. Every git command that followed
    // then failed with "fatal: this operation must be run in a work tree"
    // (to stderr, leaving stdout - and the parsed result - empty), which
    // looked identical to "no changes" to the caller.
    await initRepoWithCommit(dir)
    const worktreePath = join(tmpdir(), `git-diff-worktree-target-${Date.now()}`)
    await run('git', ['worktree', 'add', '-b', 'regression-test-branch', worktreePath, 'HEAD'], dir)

    try {
      const gitDirRaw = await runCapture('git', ['rev-parse', '--git-dir'], worktreePath)
      const adminDir = resolve(worktreePath, gitDirRaw)

      expect(await isGitRepo(adminDir)).toBe(false)
    } finally {
      await run('git', ['worktree', 'remove', '--force', worktreePath], dir)
      await run('git', ['branch', '-D', 'regression-test-branch'], dir)
    }
  })

  it('reports multiple simultaneous changes correctly', async () => {
    await initRepoWithCommit(dir)
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'existing.txt'), 'modified\n')
    writeFileSync(join(dir, 'sub', 'added.txt'), 'new\n')

    const result = await captureGitDiff(dir)
    const paths = result.files.map((f) => f.path).sort()
    expect(paths).toEqual(['existing.txt', 'sub/added.txt'])
  })
})
