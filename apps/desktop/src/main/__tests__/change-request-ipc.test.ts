import { beforeEach, expect, it, vi } from 'vitest'
import type { ChangeRequest, ProjectSpecification } from '@ai-council/project-domain'
const mock = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), requests: [] as ChangeRequest[], versions: [] as ProjectSpecification[], append: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => mock.handlers.set(name, fn) } }))
vi.mock('../participant-factory', () => ({ createParticipantFactory: () => vi.fn() }))
vi.mock('../project-event-log', () => ({ replayChangeRequests: () => mock.requests, replayProject: () => mock.versions, appendEvent: mock.append }))
import { registerChangeRequestIpcHandlers } from '../change-request-ipc'
beforeEach(() => {
  mock.append.mockReset()
  mock.requests = [{ id: 'cr', projectId: 'p', status: 'human_approved', affectedTaskIds: ['t'], affectedRequirementIds: [], reason: '', proposedChanges: '', severity: 'architecture', createdAt: 0 }]
  mock.versions = [1, 2].map(version => ({ id: 'p', version, status: 'human_approved' } as ProjectSpecification))
  registerChangeRequestIpcHandlers(() => null, {} as any, {} as any, {} as any, {} as any, {} as any)
})
const link = (specVersion: number) => mock.handlers.get('changeRequest:linkSpec')!(null, { projectId: 'p', id: 'cr', specVersion })
it.each([999, 0, -1, 1.5, NaN])('rejects invalid version %s without persisting a link', async version => {
  expect(await link(version)).toMatchObject({ ok: false })
  expect(mock.append).not.toHaveBeenCalled()
})
it.each(['council_generated', 'rejected', 'superseded'] as const)('rejects a %s specification', async status => {
  mock.versions[1].status = status
  expect(await link(2)).toMatchObject({ ok: false })
  expect(mock.append).not.toHaveBeenCalled()
})
it.each([undefined, 999, 1])('links an approved version and repairs invalid legacy link %s', async previous => {
  mock.requests[0].resultingSpecVersion = previous
  mock.versions[0].status = 'superseded'
  expect(await link(2)).toEqual({ ok: true })
  expect(mock.append).toHaveBeenCalledWith('p', expect.objectContaining({ type: 'ChangeRequestLinkedToSpec', payload: { id: 'cr', specVersion: 2 } }))
})
it('does not change a valid link that execution may already be consuming', async () => {
  mock.requests[0].resultingSpecVersion = 1
  expect(await link(2)).toMatchObject({ ok: false })
  expect(mock.append).not.toHaveBeenCalled()
})
it('does not change an applied request even if its specification is now superseded', async () => {
  mock.requests[0].appliedAt = 1
  mock.requests[0].resultingSpecVersion = 1
  mock.versions[0].status = 'superseded'
  expect(await link(2)).toMatchObject({ ok: false })
  expect(mock.append).not.toHaveBeenCalled()
})
