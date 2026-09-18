import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ensureProjectRepository, createWorktree, mergeWorktree } from '../workspace/git-worktree'

function gitSync(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`)
  }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'council-new-project-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('new project repository', { timeout: 30000 }, () => {
  it('creates a new project, runs an isolated edit and merges the first app file', async () => {
    const repo = await ensureProjectRepository(join(dir, 'new app'))
    expect(await ensureProjectRepository(repo)).toBe(repo)
    const worktree = await createWorktree(repo, join(dir, 'worktrees'))
    await writeFile(join(worktree.path, 'index.html'), '<h1>My app</h1>')
    await mergeWorktree(worktree)
    expect(await readFile(join(repo, 'index.html'), 'utf-8')).toBe('<h1>My app</h1>')
  })

  it('preserves existing unversioned files instead of committing them automatically', async () => {
    await writeFile(join(dir, 'secret.env'), 'keep private')
    await expect(ensureProjectRepository(dir)).rejects.toThrow(/bereits Dateien/)
    expect(await readFile(join(dir, 'secret.env'), 'utf-8')).toBe('keep private')
  })

  it('rejects a child directory of a foreign (non-AI-Council) repository', async () => {
    const repo = join(dir, 'someone-elses-repo')
    await mkdir(repo)
    gitSync(['init'], repo)
    gitSync(['-c', 'user.email=x@x.com', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'unrelated project'], repo)
    const child = join(repo, 'child')
    await mkdir(child)
    await expect(ensureProjectRepository(child)).rejects.toThrow(/anderen Git-Projekts/)
  })

  it('REGRESSION (sibling apps under a shared workspace root): allows a fresh, independent repo nested inside a repo AI Council itself created', async () => {
    // Caught live: a shared "Projekte"-style parent folder holding several
    // apps as subfolders made every app after the first unusable, because
    // the first app's own auto-created repo turned every descendant path
    // into a rejected "nested inside another Git project" - even though
    // that ancestor repo was AI Council's own, not a foreign one.
    const workspaceRoot = await ensureProjectRepository(join(dir, 'workspace'))
    const secondApp = join(workspaceRoot, 'second-app')
    await mkdir(secondApp)

    const repo = await ensureProjectRepository(secondApp)
    expect(repo).toBe(secondApp)

    // The new nested repo is genuinely its own, separate repository - not
    // just re-using the workspace root's.
    const worktree = await createWorktree(repo, join(dir, 'worktrees'))
    await writeFile(join(worktree.path, 'app.txt'), 'second app content')
    await mergeWorktree(worktree)
    expect(await readFile(join(repo, 'app.txt'), 'utf-8')).toBe('second app content')
    await expect(readFile(join(workspaceRoot, 'app.txt'), 'utf-8')).rejects.toThrow()
  })
})
