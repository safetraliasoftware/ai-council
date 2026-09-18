import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CodingExecutor } from '@ai-council/coding'
import type { CodingExecutorId } from '../ipc-types'

const state = vi.hoisted(() => ({
  dir: '', handlers: new Map<string, (...args: any[]) => any>(),
  merge: vi.fn(), discard: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => state.dir },
  ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => state.handlers.set(name, fn) }
}))
vi.mock('@ai-council/coding', () => ({ mergeWorktree: state.merge, discardWorktree: state.discard }))
import { registerCodingIpcHandlers } from '../coding-ipc'
import { WorktreeStore } from '../worktree-store'

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'council-worktree-ipc-'))
  const path = join(state.dir, 'worktrees', 'abc')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, '.git'), 'gitdir: fixture')
  new WorktreeStore(state.dir, () => undefined).set('run', { path, branch: 'ai-council/abc', sourceRepo: state.dir })
  state.merge.mockReset().mockResolvedValue(undefined)
  state.discard.mockReset().mockResolvedValue(undefined)
})
afterEach(() => { rmSync(state.dir, { recursive: true, force: true }) })
function restart() {
  state.handlers.clear()
  registerCodingIpcHandlers(() => null, {} as Record<CodingExecutorId, CodingExecutor>)
}

it('merges after restart and keeps the resolution across another restart', async () => {
  restart()
  expect(await state.handlers.get('coding:mergeWorktree')!(null, 'run')).toEqual({ ok: true })
  restart()
  expect(await state.handlers.get('coding:mergeWorktree')!(null, 'run')).toMatchObject({ ok: false })
  expect(state.merge).toHaveBeenCalledTimes(1)
})

it('retains the association after a failed merge and allows discarding after restart', async () => {
  state.merge.mockRejectedValueOnce(new Error('conflict'))
  restart()
  expect(await state.handlers.get('coding:mergeWorktree')!(null, 'run')).toEqual({ ok: false, error: 'conflict' })
  restart()
  expect(await state.handlers.get('coding:discardWorktree')!(null, 'run')).toEqual({ ok: true })
})
