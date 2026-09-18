import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeStore } from '../worktree-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'council-worktree-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const path = join(dir, 'worktrees', 'abc')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, '.git'), 'gitdir: fixture')
  return { path, sourceRepo: join(dir, 'source'), branch: 'ai-council/abc' }
}

it('restores a persisted association in a new store instance', () => {
  const info = fixture()
  new WorktreeStore(dir, () => undefined).set('run-1', info)
  expect(new WorktreeStore(dir, () => undefined).get('run-1')).toEqual(info)
})

it('restores old completed runs from history, but never resurrects resolved runs', () => {
  const info = fixture()
  const legacy = vi.fn(() => info)
  const store = new WorktreeStore(dir, legacy)
  expect(store.get('old-run')).toEqual(info)
  store.delete('old-run')
  legacy.mockClear()
  expect(new WorktreeStore(dir, legacy).get('old-run')).toBeUndefined()
  expect(legacy).not.toHaveBeenCalled()
})

it('ignores worktrees already removed from disk', () => {
  const info = fixture()
  const store = new WorktreeStore(dir, () => info)
  rmSync(join(info.path, '.git'))
  expect(store.get('old-run')).toBeUndefined()
})

it('rejects stored paths outside the application worktree root', () => {
  const info = fixture()
  expect(() => new WorktreeStore(dir, () => ({ ...info, path: dir })).get('run')).toThrow(/Pfad/)
})
