import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '../process/spawn-process'
import { createWorktree, discardWorktree, mergeWorktree } from '../workspace/git-worktree'

async function run(command: string, args: string[], cwd: string): Promise<{ stdout: string; exitCode: number | null }> {
  const { child, exitCode } = spawnProcess(command, args, { cwd })
  let stdout = ''
  child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf-8')))
  const code = await exitCode
  return { stdout, exitCode: code }
}

/** Windows git checkouts can normalize LF to CRLF (core.autocrlf) - irrelevant to what these tests check. */
function readNormalized(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')
}

async function initRepoWithCommit(dir: string): Promise<void> {
  await run('git', ['init'], dir)
  await run('git', ['config', 'user.email', 'test@example.com'], dir)
  await run('git', ['config', 'user.name', 'Test'], dir)
  writeFileSync(join(dir, 'app.txt'), 'original\n')
  await run('git', ['add', '-A'], dir)
  await run('git', ['commit', '-m', 'initial'], dir)
}

// Real Git subprocesses need more than the default 5 seconds on Windows.
describe('git-worktree', { timeout: 30000 }, () => {
  let repo: string
  let worktreesRoot: string

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'worktree-repo-'))
    worktreesRoot = mkdtempSync(join(tmpdir(), 'worktree-root-'))
    await initRepoWithCommit(repo)
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(worktreesRoot, { recursive: true, force: true })
  })

  it('createWorktree() checks out a real, isolated copy on its own branch', async () => {
    const info = await createWorktree(repo, worktreesRoot)

    expect(existsSync(join(info.path, 'app.txt'))).toBe(true)
    expect(readNormalized(join(info.path, 'app.txt'))).toBe('original\n')
    expect(info.sourceRepo).toBe(repo)

    const branchList = await run('git', ['branch', '--list', info.branch], repo)
    expect(branchList.stdout).toContain(info.branch)
  })

  it('changes made in the worktree do not appear in the source repo until merged', async () => {
    const info = await createWorktree(repo, worktreesRoot)
    writeFileSync(join(info.path, 'app.txt'), 'changed in worktree\n')

    // Untouched: the source repo's own working tree still has the original content.
    expect(readFileSync(join(repo, 'app.txt'), 'utf-8')).toBe('original\n')
    const status = await run('git', ['status', '--porcelain'], repo)
    expect(status.stdout.trim()).toBe('')
  })

  it('mergeWorktree() commits the worktree changes and merges them into the source repo, then cleans up', async () => {
    const info = await createWorktree(repo, worktreesRoot)
    writeFileSync(join(info.path, 'app.txt'), 'changed in worktree\n')
    writeFileSync(join(info.path, 'new.txt'), 'brand new\n')

    await mergeWorktree(info)

    expect(readNormalized(join(repo, 'app.txt'))).toBe('changed in worktree\n')
    expect(readNormalized(join(repo, 'new.txt'))).toBe('brand new\n')

    // The worktree itself is gone, and so is its throwaway branch.
    expect(existsSync(info.path)).toBe(false)
    const branchList = await run('git', ['branch', '--list', info.branch], repo)
    expect(branchList.stdout).not.toContain(info.branch)
  })

  it('REGRESSION (worktree lost on failed merge): a merge blocked by the source repo\'s own uncommitted changes leaves the worktree and branch intact for a retry', async () => {
    // Caught live: the source repo had its own pre-existing uncommitted
    // change to a file the worktree also touched, so git correctly refused
    // to merge ("local changes would be overwritten by merge") - but the
    // old cleanup ran regardless of outcome, permanently deleting the
    // worktree and branch on the very first failed attempt. The reviewed
    // changes must survive a failed merge so the user can resolve whatever
    // blocked it and retry "Übernehmen".
    const info = await createWorktree(repo, worktreesRoot)
    writeFileSync(join(info.path, 'app.txt'), 'changed in worktree\n')

    // The source repo's own working tree has an uncommitted, conflicting change.
    writeFileSync(join(repo, 'app.txt'), 'uncommitted local edit\n')

    await expect(mergeWorktree(info)).rejects.toThrow(/would be overwritten by merge/)
    // A friendly, actionable explanation is appended - not just the raw git error.
    await expect(mergeWorktree(info)).rejects.toThrow(/committe.*oder.*stashe/i)

    // Nothing was lost: the worktree, its branch, and the source repo's own
    // uncommitted change are all still exactly where they were.
    expect(existsSync(info.path)).toBe(true)
    expect(readNormalized(join(info.path, 'app.txt'))).toBe('changed in worktree\n')
    const branchList = await run('git', ['branch', '--list', info.branch], repo)
    expect(branchList.stdout).toContain(info.branch)
    expect(readNormalized(join(repo, 'app.txt'))).toBe('uncommitted local edit\n')

    // Resolving the block (here: discarding the local edit) lets a retry succeed.
    await run('git', ['checkout', '--', 'app.txt'], repo)
    await mergeWorktree(info)
    expect(readNormalized(join(repo, 'app.txt'))).toBe('changed in worktree\n')
    expect(existsSync(info.path)).toBe(false)
  })

  it('mergeWorktree() succeeds even when the worktree has no changes at all', async () => {
    const info = await createWorktree(repo, worktreesRoot)
    await expect(mergeWorktree(info)).resolves.toBeUndefined()
    expect(existsSync(info.path)).toBe(false)
  })

  it('discardWorktree() removes the worktree and its branch without touching the source repo', async () => {
    const info = await createWorktree(repo, worktreesRoot)
    writeFileSync(join(info.path, 'app.txt'), 'changed in worktree\n')
    writeFileSync(join(info.path, 'new.txt'), 'brand new\n')

    await discardWorktree(info)

    expect(existsSync(info.path)).toBe(false)
    expect(readFileSync(join(repo, 'app.txt'), 'utf-8')).toBe('original\n')
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    const branchList = await run('git', ['branch', '--list', info.branch], repo)
    expect(branchList.stdout).not.toContain(info.branch)
  })

  it('two worktrees from the same repo are independent of each other', async () => {
    const a = await createWorktree(repo, worktreesRoot)
    const b = await createWorktree(repo, worktreesRoot)

    writeFileSync(join(a.path, 'app.txt'), 'from a\n')
    writeFileSync(join(b.path, 'app.txt'), 'from b\n')

    expect(readFileSync(join(a.path, 'app.txt'), 'utf-8')).toBe('from a\n')
    expect(readFileSync(join(b.path, 'app.txt'), 'utf-8')).toBe('from b\n')

    await discardWorktree(a)
    await discardWorktree(b)
  })
})
