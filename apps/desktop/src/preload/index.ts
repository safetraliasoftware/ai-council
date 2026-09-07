import { contextBridge, ipcRenderer } from 'electron'
import type { ProviderId } from '@ai-council/shared'
import type { CouncilRunEvent } from '@ai-council/council-core'
import type {
  SettingsState,
  TestKeyResult,
  ParallelRunRequestDto,
  TeamRunRequestDto,
  CouncilRunRequestDto,
  CodingExecutorId,
  CodingDetectResult,
  StartCodingTaskDto,
  CodingEventEnvelope
} from '../main/ipc-types'

const api = {
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    setKey: (provider: ProviderId, apiKey: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setKey', provider, apiKey),
    clearKey: (provider: ProviderId): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:clearKey', provider),
    setModel: (provider: ProviderId, model: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setModel', provider, model),
    testKey: (provider: ProviderId): Promise<TestKeyResult> =>
      ipcRenderer.invoke('settings:testKey', provider)
  },
  task: {
    runParallel: (req: ParallelRunRequestDto): Promise<{ runId: string }> =>
      ipcRenderer.invoke('task:runParallel', req),
    runTeam: (req: TeamRunRequestDto): Promise<{ runId: string }> =>
      ipcRenderer.invoke('task:runTeam', req),
    runCouncil: (req: CouncilRunRequestDto): Promise<{ runId: string }> =>
      ipcRenderer.invoke('task:runCouncil', req),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke('task:cancel', runId),
    onEvent: (cb: (e: CouncilRunEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CouncilRunEvent): void => cb(payload)
      ipcRenderer.on('council:event', listener)
      return (): void => {
        ipcRenderer.removeListener('council:event', listener)
      }
    }
  },
  coding: {
    detect: (executorId: CodingExecutorId): Promise<CodingDetectResult> =>
      ipcRenderer.invoke('coding:detect', executorId),
    pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('coding:pickDirectory'),
    startTask: (req: StartCodingTaskDto): Promise<{ taskId: string }> =>
      ipcRenderer.invoke('coding:startTask', req),
    resumeSession: (
      req: StartCodingTaskDto & { sessionId: string }
    ): Promise<{ taskId: string }> => ipcRenderer.invoke('coding:resumeSession', req),
    abort: (executorId: CodingExecutorId, taskId: string): Promise<void> =>
      ipcRenderer.invoke('coding:abort', { executorId, taskId }),
    onEvent: (cb: (e: CodingEventEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CodingEventEnvelope): void => cb(payload)
      ipcRenderer.on('coding:event', listener)
      return (): void => {
        ipcRenderer.removeListener('coding:event', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
