import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), start: vi.fn(), accept: vi.fn(), release: vi.fn(), setTaskBudget: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => 'data' }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => state.handlers.set(name, fn) } }))
vi.mock('../../services/project-engine', () => ({ ProjectEngine: class { start = state.start; accept = state.accept; release = state.release; setTaskBudget = state.setTaskBudget } }))
import { registerTaskGraphExecutionIpcHandlers } from '../task-graph-execution-ipc'
beforeEach(() => {
  vi.resetAllMocks()
  registerTaskGraphExecutionIpcHandlers(() => null, {} as any, async () => '')
})
it('routes task starts to the domain service and exposes gate failures to the UI', async () => {
  state.start.mockRejectedValue(new Error('Specification not approved'))
  const req = { projectId: 'p', taskId: 't', implementerId: 'claude-code-cli', reviewerId: 'openai-codex-cli' }
  expect(await state.handlers.get('taskGraph:runTask')!(null, req)).toEqual({ workflowId: '', error: 'Specification not approved' })
  expect(state.start).toHaveBeenCalledWith('p', 't', req)
})
it('saves a task-specific budget through its own handler and exposes errors', async () => {
  const budget = { maxCalls: 8, maxCorrections: 2, maxActiveMs: 3600000 }
  expect(await state.handlers.get('taskGraph:setTaskBudget')!(null, 'p', 'TASK-004', budget)).toEqual({ ok: true })
  expect(state.setTaskBudget).toHaveBeenCalledWith('p', 'TASK-004', budget)
  state.setTaskBudget.mockRejectedValue(new Error('Task nicht gefunden.'))
  expect(await state.handlers.get('taskGraph:setTaskBudget')!(null, 'p', 'missing', budget)).toEqual({ ok: false, error: 'Task nicht gefunden.' })
})
it('does not hide verification failures during acceptance', async () => {
  state.accept.mockRejectedValue(new Error('Verification failed'))
  expect(await state.handlers.get('taskGraph:acceptTask')!(null, { projectId: 'p', taskId: 't' })).toEqual({ ok: false, error: 'Verification failed' })
})
it('passes the exact human-approved commit to the release gate', async () => {
  state.release.mockResolvedValue(undefined)
  expect(await state.handlers.get('taskGraph:release')!(null, 'p', 'abc')).toEqual({ ok: true })
  expect(state.release).toHaveBeenCalledWith('p', 'abc')
})
