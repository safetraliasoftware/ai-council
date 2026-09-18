import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { diffWorkspaceSnapshots, verifyWorkspaceUnchanged } from '../policy/policy-decision'
import { snapshotWorkspace, type WorkspaceSnapshot } from '../verification'

function snapshot(digest: string, entries: Record<string, string>): WorkspaceSnapshot {
  return { digest, entries: new Map(Object.entries(entries)) }
}

describe('diffWorkspaceSnapshots', () => {
  it('allows when the digest is unchanged', () => {
    expect(diffWorkspaceSnapshots(snapshot('same', { a: '1' }), snapshot('same', { a: '1' }))).toEqual({ outcome: 'allow' })
  })

  it('denies and names the differing path when the digest changed', () => {
    const before = snapshot('before', { 'app.txt': 'file(mode=1, 1b, aaa)' })
    const after = snapshot('after', { 'app.txt': 'file(mode=1, 1b, bbb)' })
    expect(diffWorkspaceSnapshots(before, after)).toEqual({
      outcome: 'deny',
      reason: 'Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert: app.txt'
    })
  })

  it('names an added or removed path even without any content actually differing elsewhere', () => {
    const before = snapshot('before', { a: '1' })
    const after = snapshot('after', { a: '1', b: '2' })
    expect(diffWorkspaceSnapshots(before, after)).toEqual({
      outcome: 'deny',
      reason: 'Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert: b'
    })
  })

  it('names up to 5 differing paths and counts the rest instead of listing everything', () => {
    const before = snapshot('before', { a: '1', b: '1', c: '1', d: '1', e: '1', f: '1' })
    const after = snapshot('after', { a: '2', b: '2', c: '2', d: '2', e: '2', f: '2' })
    const decision = diffWorkspaceSnapshots(before, after)
    expect(decision).toEqual({
      outcome: 'deny',
      reason: 'Das Arbeitsverzeichnis hat sich während eines schreibgeschützten Laufs verändert: a, b, c, d, e (+1 weitere)'
    })
  })
})

function gitSync(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`)
}

describe('verifyWorkspaceUnchanged', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'council-verify-workspace-'))
    gitSync(['init'], dir)
    gitSync(['-c', 'user.email=x@x.com', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'init'], dir)
  })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('allows immediately when nothing changed', async () => {
    const before = await snapshotWorkspace(dir)
    expect(await verifyWorkspaceUnchanged(before, dir, 20)).toEqual({ outcome: 'allow' })
  })

  it(
    'REGRESSION (nachlaufender Hintergrundprozess löste einen Fehlalarm aus): ' +
      'tolerates a straggler write that settles back to the original state before the retry check, ' +
      'but names it as a tolerated transient instead of allowing silently',
    async () => {
      const before = await snapshotWorkspace(dir)
      await writeFile(join(dir, 'app.txt'), 'transient write from e.g. a lingering build server')
      // snapshotWorkspace() spawns real git subprocesses (ls-files, rev-parse)
      // per call, which alone can take a few hundred ms on Windows - the
      // cleanup must land comfortably after the FIRST check has actually
      // sampled the filesystem (else it never observes the file at all,
      // making this test pass for the wrong reason) and comfortably before
      // the retry's own check, hence the generous, well-separated delays.
      const cleanup = new Promise<void>(resolve => {
        setTimeout(() => { void rm(join(dir, 'app.txt'), { force: true }).then(resolve) }, 700)
      })
      const [decision] = await Promise.all([verifyWorkspaceUnchanged(before, dir, 800), cleanup])
      expect(decision.outcome).toBe('allow')
      // Security-reviewed: a write that self-reverts within the retry window
      // would otherwise be indistinguishable from a benign straggler and
      // vanish without a trace - callers must be able to surface this.
      expect(decision.toleratedTransient).toContain('app.txt')
    }
  )

  it('still denies, naming the path, when the change is a real one that persists past the retry', async () => {
    const before = await snapshotWorkspace(dir)
    await writeFile(join(dir, 'app.txt'), 'a real, lasting change')
    const decision = await verifyWorkspaceUnchanged(before, dir, 20)
    expect(decision.outcome).toBe('deny')
    expect(decision.reason).toContain('app.txt')
  })
})
