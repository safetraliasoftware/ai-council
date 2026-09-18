import { beforeEach, expect, it, vi } from 'vitest'
import type { ChangeRequest, ProjectSpecification } from '@ai-council/project-domain'

const mock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), requests: [] as ChangeRequest[],
  build: vi.fn(), council: vi.fn(), append: vi.fn(), send: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) } }))
vi.mock('../participant-factory', () => ({ createParticipantFactory: () => mock.build }))
vi.mock('../usage-store', () => ({ recordCouncilUsage: (run: unknown) => run }))
vi.mock('@ai-council/council-core', () => ({ runCouncil: mock.council }))
vi.mock('../company-truth-store', () => ({ listCompanyFacts: () => [] }))
vi.mock('../task-graph-store', () => ({ readTaskGraph: () => ({ specVersion: 1, workingDirectory: 'project', tasks: [] }) }))
vi.mock('../project-event-log', () => ({
  replayChangeRequests: () => structuredClone(mock.requests),
  replayProject: () => [{ id: 'p', version: 1, goal: 'Project', requirements: [], architectureNotes: '' } as unknown as ProjectSpecification],
  appendEvent: (...args: unknown[]) => mock.append(...args)
}))
import { registerChangeRequestIpcHandlers } from '../change-request-ipc'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let finish: ReturnType<typeof deferred>
const request = { projectId: 'p', id: 'cr', providers: ['anthropic'], chairId: 'anthropic' }
const call = (channel: string, req: unknown) => mock.handlers.get(`changeRequest:${channel}`)!(null, req)
function persist(_id: string, event: any) {
  if (event.type === 'ChangeRequestProposalUpdated') Object.assign(mock.requests[0], event.payload)
  if (event.type === 'ChangeRequestCouncilEvaluated') mock.requests[0].status = 'council_approved'
}
beforeEach(() => {
  vi.resetAllMocks()
  finish = deferred()
  mock.requests = [{ id: 'cr', projectId: 'p', status: 'pending', affectedTaskIds: [], affectedRequirementIds: [], reason: 'Problem', proposedChanges: 'old proposal', severity: 'architecture', createdAt: 0 }]
  mock.append.mockImplementation(async (...args) => persist(args[0], args[1]))
  mock.build.mockResolvedValue({ id: 'anthropic' })
  ;(mock.build as any).prepare = async (ids: string[], directory?: string) => Promise.all(ids.map(id => mock.build(id, directory)))
  mock.council.mockImplementation(() => ({ runId: 'run', events: (async function* () {
    await finish.promise
    yield { kind: 'provider_event', stage: 'synthesis', event: { type: 'done', result: { text: '{"recommendation":"proceed","rationale":"Evaluated"}' } } }
  })() }))
  registerChangeRequestIpcHandlers(() => ({ isDestroyed: () => false, webContents: { send: mock.send } }) as any, {} as any, {} as any, {} as any, {} as any, {} as any)
})
async function complete() {
  finish.resolve()
  await vi.waitFor(() => expect(mock.send).toHaveBeenCalledWith('changeRequest:evaluated', expect.objectContaining({ ok: true })))
}

it('waits for an in-flight autosave and evaluates the exact submitted draft', async () => {
  const saved = deferred()
  mock.append.mockImplementationOnce(async (...args) => { await saved.promise; persist(args[0], args[1]) })
  const autosave = call('updateProposal', { projectId: 'p', id: 'cr', proposedChanges: 'blur save', severity: 'architecture' })
  const evaluation = call('evaluate', { ...request, proposal: { proposedChanges: 'latest typed proposal', severity: 'security' } })
  await Promise.resolve()
  expect(mock.build).not.toHaveBeenCalled()
  saved.resolve()
  expect(await autosave).toEqual({ ok: true })
  expect(await evaluation).toEqual({ runId: 'run' })
  expect(mock.requests[0]).toMatchObject({ proposedChanges: 'latest typed proposal', severity: 'security' })
  expect(mock.council.mock.calls[0][0].request.messages[0].content).toContain('latest typed proposal')
  expect(mock.council.mock.calls[0][0].request.messages[0].content).not.toContain('blur save')
  await complete()
})

it('reserves the request before participant setup and rejects duplicate starts or edits', async () => {
  const ready = deferred()
  mock.build.mockImplementation(async () => { await ready.promise; return { id: 'anthropic' } })
  const first = call('evaluate', request)
  await vi.waitFor(() => expect(mock.build).toHaveBeenCalledTimes(1))
  expect(await call('evaluate', request)).toEqual({ runId: '' })
  expect(await call('updateProposal', { projectId: 'p', id: 'cr', proposedChanges: 'changed', severity: 'minor' })).toMatchObject({ ok: false })
  expect(await call('approve', request)).toMatchObject({ ok: false })
  expect(await call('reject', request)).toMatchObject({ ok: false })
  ready.resolve()
  await first
  expect(mock.council).toHaveBeenCalledTimes(1)
  await complete()
})

it('releases the reservation after participant setup fails so the user can retry', async () => {
  mock.build.mockRejectedValueOnce(new Error('Agent unavailable'))
  await expect(call('evaluate', request)).rejects.toThrow('Agent unavailable')
  expect(await call('evaluate', request)).toEqual({ runId: 'run' })
  await complete()
})

it('does not start the council if saving the submitted proposal fails', async () => {
  mock.append.mockRejectedValueOnce(new Error('disk full'))
  await expect(call('evaluate', { ...request, proposal: { proposedChanges: 'new', severity: 'minor' } })).rejects.toThrow('disk full')
  expect(mock.council).not.toHaveBeenCalled()
  expect(await call('evaluate', request)).toEqual({ runId: 'run' })
  await complete()
})

it.each(['council_approved', 'human_approved', 'rejected'] as const)('does not reevaluate a %s request', async status => {
  mock.requests[0].status = status
  await expect(call('evaluate', request)).rejects.toThrow(/Nur offene/)
  expect(mock.council).not.toHaveBeenCalled()
})

it.each([[], ['openai'], ['anthropic', 'anthropic']])('rejects invalid participant selection %j', async (...providers) => {
  await expect(call('evaluate', { ...request, providers })).rejects.toThrow(/Teilnehmer/)
  expect(mock.council).not.toHaveBeenCalled()
})
