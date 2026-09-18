import { beforeEach, expect, it, vi } from 'vitest'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), graph: undefined as TaskGraphSnapshot | undefined,
  openStatuses: [] as string[], executionStarted: false, build: vi.fn(), council: vi.fn(), write: vi.fn(), send: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) } }))
vi.mock('../participant-factory', () => ({ createParticipantFactory: () => mock.build }))
vi.mock('../usage-store', () => ({ recordCouncilUsage: (run: unknown) => run }))
vi.mock('@ai-council/council-core', () => ({ runCouncil: mock.council }))
vi.mock('../company-truth-store', () => ({ listCompanyFacts: () => [] }))
vi.mock('../project-directory-store', () => ({ readProjectDirectory: () => undefined }))
vi.mock('../task-graph-store', () => ({ readTaskGraph: () => structuredClone(mock.graph), writeTaskGraph: (...args: unknown[]) => mock.write(...args) }))
vi.mock('../project-event-log', () => ({ replayProject: () => [{ version: 2, status: 'human_approved', goal: 'App', requirements: [], architectureNotes: '', nonGoals: [], risks: [], openQuestions: [] }] }))
vi.mock('../execution-store', () => ({ hasOpenAttempts: () => mock.openStatuses.length > 0, hasExecutionStarted: () => mock.executionStarted }))
import { registerTaskGraphIpcHandlers } from '../task-graph-ipc'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let finish: ReturnType<typeof deferred>
const generate = () => mock.handlers.get('taskGraph:generate')!(null, { projectId: 'p', specVersion: 2, providers: ['anthropic'], chairId: 'anthropic' })
const executing = (status: string) => { mock.executionStarted = true; mock.openStatuses = [status] }
beforeEach(() => {
  vi.resetAllMocks()
  finish = deferred(); mock.openStatuses = []; mock.executionStarted = false
  mock.graph = { projectId: 'p', specVersion: 1, status: 'human_approved', tasks: [], chairId: 'anthropic', rawSynthesisText: '', createdAt: 1, updatedAt: 1 }
  mock.build.mockResolvedValue({ id: 'anthropic' })
  ;(mock.build as any).prepare = async (ids: string[], directory?: string) => Promise.all(ids.map(id => mock.build(id, directory)))
  mock.write.mockImplementation((_id, graph) => { mock.graph = graph })
  mock.council.mockImplementation(() => ({ runId: 'run', events: (async function* () {
    yield { kind: 'provider_event', stage: 'synthesis', providerId: 'anthropic', event: { type: 'done', result: { text: '[{"id":"t","title":"Task","requirementIds":[],"dependencies":[],"scope":{"allowedPaths":[]}}]' } } }
    await finish.promise
  })() }))
  registerTaskGraphIpcHandlers(() => ({ isDestroyed: () => false, webContents: { send: mock.send } }) as any, {} as any, {} as any, {} as any, {} as any)
})
async function complete(ok: boolean) {
  finish.resolve()
  await vi.waitFor(() => expect(mock.send).toHaveBeenCalledWith('taskGraph:generated', expect.objectContaining({ ok })))
}
it.each(['compact', 'full'])('forwards %s planning to the council', async deliberation => {
  await mock.handlers.get('taskGraph:generate')!(null, { projectId: 'p', specVersion: 2, providers: ['anthropic'], chairId: 'anthropic', deliberation })
  expect(mock.council).toHaveBeenCalledWith(expect.objectContaining({ deliberation }))
  await complete(true)
})
it.each(['running', 'review', 'awaiting_permission', 'awaiting_install'])('blocks replanning while an attempt is %s', async status => {
  executing(status)
  await expect(generate()).rejects.toThrow(/Offene Ausführungsversuche/)
  expect(mock.build).not.toHaveBeenCalled()
  expect(mock.write).not.toHaveBeenCalled()
})
it('checks execution state again before saving a generated graph', async () => {
  await generate()
  executing('awaiting_install')
  await complete(false)
  expect(mock.write).not.toHaveBeenCalled()
})
it('preserves a graph mutation even when updatedAt was not changed', async () => {
  await generate()
  mock.graph!.rawSynthesisText = 'Changed while planning'
  await complete(false)
  expect(mock.write).not.toHaveBeenCalled()
})
it('does not save a cancelled synthesis and permits retry after it finishes', async () => {
  await generate()
  mock.handlers.get('taskGraph:cancel')!(null, 'run')
  await expect(generate()).rejects.toThrow(/bereits/)
  await complete(false)
  expect(mock.write).not.toHaveBeenCalled()
  await generate()
  await complete(true)
  expect(mock.write).toHaveBeenCalledTimes(1)
})
it('reserves the project during participant setup', async () => {
  const ready = deferred()
  mock.build.mockImplementation(async () => { await ready.promise; return { id: 'anthropic' } })
  const first = generate()
  await vi.waitFor(() => expect(mock.build).toHaveBeenCalledTimes(1))
  await expect(generate()).rejects.toThrow(/bereits/)
  ready.resolve(); await first; await complete(true)
  expect(mock.council).toHaveBeenCalledTimes(1)
})
it('releases the reservation after a startup failure', async () => {
  mock.build.mockRejectedValueOnce(new Error('Unavailable'))
  await expect(generate()).rejects.toThrow('Unavailable')
  await generate(); await complete(true)
})
