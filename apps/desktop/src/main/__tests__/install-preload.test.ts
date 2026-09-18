import { expect, it, vi } from 'vitest'
import type { Api } from '../../preload'
import type { RespondInstallRequestDto } from '../ipc-types'

const bridge = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: bridge.expose },
  ipcRenderer: { invoke: bridge.invoke }
}))
import '../../preload'

it.each<RespondInstallRequestDto['decision']>([
  { approved: false },
  { approved: true, command: { executable: 'installer', args: ['path with spaces', '--version', '8'], timeoutMs: 600000 } }
])('exposes the installation decision to the renderer and preserves arguments: %j', async decision => {
  const api = bridge.expose.mock.calls.find(([name]) => name === 'api')![1] as Api
  const request = { projectId: 'p', attemptId: 'a', decision }
  bridge.invoke.mockResolvedValueOnce({ ok: true })
  expect(await api.taskGraph.respondInstall(request)).toEqual({ ok: true })
  expect(bridge.invoke).toHaveBeenLastCalledWith('taskGraph:respondInstall', request)
})
