import { beforeEach, expect, it, vi } from 'vitest'
import type { ProjectSpecification } from '@ai-council/project-domain'
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), build: vi.fn(), council: vi.fn(), append: vi.fn(), send: vi.fn(), specs: [] as ProjectSpecification[] }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) } }))
vi.mock('../participant-factory', () => ({ createParticipantFactory: () => mock.build }))
vi.mock('../usage-store', () => ({ recordCouncilUsage: (run: unknown) => run }))
vi.mock('@ai-council/council-core', () => ({ runCouncil: mock.council }))
vi.mock('../company-truth-store', () => ({ listCompanyFacts: () => [] }))
vi.mock('../project-directory-store', () => ({ readProjectDirectory: () => undefined, writeProjectDirectory: vi.fn() }))
vi.mock('../project-event-log', () => ({ replayProject: (id: string) => structuredClone(mock.specs.filter(s => s.id === id)), appendEvent: (...args: unknown[]) => mock.append(...args), listProjectIds: () => ['p'] }))
import { registerProjectSpecIpcHandlers } from '../project-spec-ipc'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let finish: ReturnType<typeof deferred>
beforeEach(() => {
  vi.resetAllMocks()
  finish = deferred()
  mock.specs = [{ id: 'p', version: 1, status: 'human_approved', goal: 'App', requirements: [{ id: 'REQ-STABLE', category: 'feature', statement: 'Preserve offline support', acceptanceCriteria: ['Works without network'], priority: 'must' }], architectureNotes: 'Use SQLite exclusively', nonGoals: ['No cloud sync'], risks: ['Concurrent writes'], openQuestions: [{ text: 'Backup frequency?', blocking: true }], chairId: 'anthropic', rawSynthesisText: '', createdAt: 0, updatedAt: 0 }]
  mock.build.mockResolvedValue({ id: 'anthropic' })
  ;(mock.build as any).prepare = async (ids: string[], directory?: string) => Promise.all(ids.map(id => mock.build(id, directory)))
  mock.council.mockImplementation(() => ({ runId: String(mock.council.mock.calls.length), events: (async function* () {
    yield { kind: 'provider_event', stage: 'synthesis', providerId: 'anthropic', event: { type: 'done', result: { text: JSON.stringify({ requirements: [], nonGoals: [], architectureNotes: '', risks: [], openQuestions: [] }) } } }
    await finish.promise
  })() }))
  mock.append.mockImplementation(async (_id, event) => {
    if (event.type === 'SpecificationCouncilGenerated') mock.specs.push(event.payload)
  })
  registerProjectSpecIpcHandlers(() => ({ isDestroyed: () => false, webContents: { send: mock.send } }) as any, {} as any, {} as any, {} as any, {} as any)
})
const req = { projectId: 'p', goal: 'App', userNote: 'Change the title color', providers: ['anthropic'], chairId: 'anthropic' }
const generate = (projectId = 'p') => mock.handlers.get('projectSpec:generate')!(null, { ...req, projectId })
it.each(['compact', 'full'])('forwards %s planning to the council', async deliberation => {
  await mock.handlers.get('projectSpec:generate')!(null, { ...req, deliberation })
  expect(mock.council).toHaveBeenCalledWith(expect.objectContaining({ deliberation }))
  await complete()
})
async function complete(count = 1) {
  finish.resolve()
  await vi.waitFor(() => expect(mock.send.mock.calls.filter(([channel]) => channel === 'projectSpec:generated')).toHaveLength(count))
}
it('passes all previous specification content and the requested change into a revision', async () => {
  await generate()
  const prompt = mock.council.mock.calls[0][0].request.messages[0].content
  for (const text of ['Change the title color', 'REQ-STABLE', 'Works without network', 'Use SQLite exclusively', 'No cloud sync', 'Concurrent writes', 'Backup frequency?']) expect(prompt).toContain(text)
  expect(prompt).toContain('Erhalte unveränderte Anforderungen mit ihren IDs')
  expect(prompt).toContain('vollständige neue Spezifikation')
  await complete()
})
it('blocks duplicates during preparation and streaming, then assigns the next version', async () => {
  const ready = deferred()
  mock.build.mockImplementationOnce(async () => { await ready.promise; return { id: 'anthropic' } })
  const first = generate()
  await vi.waitFor(() => expect(mock.build).toHaveBeenCalledTimes(1))
  await expect(generate()).rejects.toThrow(/bereits/)
  ready.resolve()
  await first
  await expect(generate()).rejects.toThrow(/bereits/)
  await complete()
  await generate()
  await complete(2)
  expect(mock.specs.map(s => s.version)).toEqual([1, 2, 3])
})
it('allows different projects to generate concurrently', async () => {
  await Promise.all([generate(), generate('other')])
  expect(mock.council).toHaveBeenCalledTimes(2)
  await complete(2)
  expect(mock.specs.find(s => s.id === 'other')?.version).toBe(1)
})
it.each(['build', 'append'] as const)('releases the project lock after %s fails', async stage => {
  mock[stage].mockRejectedValueOnce(new Error('startup failed'))
  await expect(generate()).rejects.toThrow('startup failed')
  await generate()
  await complete()
  expect(mock.specs.map(s => s.version)).toEqual([1, 2])
})
it('does not persist a cancelled result or release its lock before the old run ends', async () => {
  const { runId } = await generate()
  mock.handlers.get('projectSpec:cancel')!(null, runId)
  await expect(generate()).rejects.toThrow(/bereits/)
  await complete()
  expect(mock.specs).toHaveLength(1)
  expect(mock.send).toHaveBeenCalledWith('projectSpec:generated', expect.objectContaining({ ok: false }))
  await generate()
  await complete(2)
  expect(mock.specs.map(s => s.version)).toEqual([1, 2])
})
