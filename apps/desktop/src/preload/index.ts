import type { UsageRecord } from '../main/usage-store'
import type { UiLanguage } from '../main/language-config'
import { contextBridge, ipcRenderer } from 'electron'
import type { TaskBudget } from '@ai-council/project-domain'
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
  CodingEventEnvelope,
  RunWorkflowDto,
  RunWorkflowResult,
  WorktreeActionResult,
  WorkflowEventEnvelope,
  CodingRunRecord,
  WorkflowRunRecord,
  HistoryRunRecord,
  HistoryListEntry,
  ProjectProfile,
  CaptureDiffResult,
  CompanyFact,
  CompanyFactCategory,
  GenerateSpecRequestDto,
  ProjectSpecGeneratedEnvelope,
  ParticipantBackendChoice,
  GenerateTaskGraphRequestDto,
  TaskGraphGeneratedEnvelope,
  SetTaskGraphWorkingDirectoryDto,
  RunTaskGraphTaskDto,
  RespondPermissionRequestDto,
  RespondInstallRequestDto,
  TaskGraphRunResult,
  TaskGraphTaskEventEnvelope,
  AcceptOrDiscardTaskDto,
  UpdateChangeRequestProposalDto,
  EvaluateChangeRequestDto,
  ChangeRequestEvaluatedEnvelope,
  SetProjectWorkingDirectoryDto
} from '../main/ipc-types'
import type { ProjectSpecification, TaskGraphSnapshot, ProjectExecution, CommandSpec, ChangeRequest } from '@ai-council/project-domain'
import type { ExecutorAvailability } from '@ai-council/coding'

const api = {
  usage: { list: (projectId?: string): Promise<UsageRecord[]> => ipcRenderer.invoke('usage:list', projectId) },
  updates: {
    check: (): Promise<void> => ipcRenderer.invoke('updates:check'),
    getVersion: (): Promise<string> => ipcRenderer.invoke('updates:getVersion')
  },
  settings: {
    get: (): Promise<SettingsState> => ipcRenderer.invoke('settings:get'),
    setKey: (provider: ProviderId, apiKey: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setKey', provider, apiKey),
    clearKey: (provider: ProviderId): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:clearKey', provider),
    setModel: (provider: ProviderId, model: string): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setModel', provider, model),
    setBackend: (provider: ProviderId, choice: ParticipantBackendChoice): Promise<SettingsState> =>
      ipcRenderer.invoke('settings:setBackend', provider, choice),
    getAllowPaidApiFallback: (): Promise<boolean> => ipcRenderer.invoke('settings:getAllowPaidApiFallback'),
    setAllowPaidApiFallback: (value: boolean): Promise<void> =>
      ipcRenderer.invoke('settings:setAllowPaidApiFallback', value),
    testKey: (provider: ProviderId): Promise<TestKeyResult> =>
      ipcRenderer.invoke('settings:testKey', provider),
    getWorkspaceRoot: (): Promise<string | undefined> => ipcRenderer.invoke('settings:getWorkspaceRoot'),
    setWorkspaceRoot: (path: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('settings:setWorkspaceRoot', path),
    getLanguage: (): Promise<UiLanguage> => ipcRenderer.invoke('settings:getLanguage'),
    setLanguage: (language: UiLanguage): Promise<void> => ipcRenderer.invoke('settings:setLanguage', language),
    getHasCompletedOnboarding: (): Promise<boolean> => ipcRenderer.invoke('settings:getHasCompletedOnboarding'),
    setHasCompletedOnboarding: (value: boolean): Promise<void> =>
      ipcRenderer.invoke('settings:setHasCompletedOnboarding', value)
  },
  task: {
    runParallel: (req: ParallelRunRequestDto): Promise<{ runId: string; error?: string }> =>
      ipcRenderer.invoke('task:runParallel', req),
    runTeam: (req: TeamRunRequestDto): Promise<{ runId: string; error?: string }> =>
      ipcRenderer.invoke('task:runTeam', req),
    runCouncil: (req: CouncilRunRequestDto): Promise<{ runId: string; error?: string }> =>
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
    detectAll: (): Promise<Record<CodingExecutorId, ExecutorAvailability>> =>
      ipcRenderer.invoke('coding:detectAll'),
    installExecutor: (executorId: CodingExecutorId): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('coding:installExecutor', executorId),
    loginExecutor: (executorId: CodingExecutorId): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('coding:loginExecutor', executorId),
    pickDirectory: (): Promise<string | undefined> => ipcRenderer.invoke('coding:pickDirectory'),
    startTask: (req: StartCodingTaskDto): Promise<{ taskId: string; error?: string }> =>
      ipcRenderer.invoke('coding:startTask', req),
    resumeSession: (
      req: StartCodingTaskDto & { sessionId: string }
    ): Promise<{ taskId: string; error?: string }> => ipcRenderer.invoke('coding:resumeSession', req),
    abort: (executorId: CodingExecutorId, taskId: string): Promise<void> =>
      ipcRenderer.invoke('coding:abort', { executorId, taskId }),
    onEvent: (cb: (e: CodingEventEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CodingEventEnvelope): void => cb(payload)
      ipcRenderer.on('coding:event', listener)
      return (): void => {
        ipcRenderer.removeListener('coding:event', listener)
      }
    },
    runWorkflow: (req: RunWorkflowDto): Promise<RunWorkflowResult> =>
      ipcRenderer.invoke('coding:runWorkflow', req),
    abortWorkflow: (workflowId: string): Promise<void> =>
      ipcRenderer.invoke('coding:abortWorkflow', workflowId),
    mergeWorktree: (workflowId: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('coding:mergeWorktree', workflowId),
    discardWorktree: (workflowId: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('coding:discardWorktree', workflowId),
    onWorkflowEvent: (cb: (e: WorkflowEventEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: WorkflowEventEnvelope): void => cb(payload)
      ipcRenderer.on('coding:workflowEvent', listener)
      return (): void => {
        ipcRenderer.removeListener('coding:workflowEvent', listener)
      }
    }
  },
  history: {
    list: (kind?: 'coding' | 'workflow'): Promise<HistoryListEntry[]> =>
      ipcRenderer.invoke('history:list', kind),
    get: (id: string): Promise<HistoryRunRecord | undefined> => ipcRenderer.invoke('history:get', id),
    saveCodingRun: (record: Omit<CodingRunRecord, 'id' | 'kind'>): Promise<{ id: string }> =>
      ipcRenderer.invoke('history:saveCodingRun', record),
    saveWorkflowRun: (record: Omit<WorkflowRunRecord, 'id' | 'kind'>): Promise<{ id: string }> =>
      ipcRenderer.invoke('history:saveWorkflowRun', record)
  },
  projects: {
    list: (): Promise<ProjectProfile[]> => ipcRenderer.invoke('projects:list'),
    save: (
      input: Pick<ProjectProfile, 'name' | 'workingDirectory' | 'defaultPermissionTier'>
    ): Promise<ProjectProfile> => ipcRenderer.invoke('projects:save', input),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
    touch: (id: string): Promise<void> => ipcRenderer.invoke('projects:touch', id)
  },
  artifacts: {
    captureDiff: (workingDirectory: string): Promise<CaptureDiffResult> =>
      ipcRenderer.invoke('artifacts:captureDiff', workingDirectory),
    readFile: (): Promise<CaptureDiffResult> => ipcRenderer.invoke('artifacts:readFile')
  },
  companyTruth: {
    list: (): Promise<CompanyFact[]> => ipcRenderer.invoke('companyTruth:list'),
    add: (category: CompanyFactCategory, text: string): Promise<CompanyFact> =>
      ipcRenderer.invoke('companyTruth:add', category, text),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('companyTruth:delete', id)
  },
  projectSpec: {
    generate: (req: GenerateSpecRequestDto): Promise<{ runId: string; projectId: string }> =>
      ipcRenderer.invoke('projectSpec:generate', req),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke('projectSpec:cancel', runId),
    approve: (projectId: string, version: number): Promise<void> =>
      ipcRenderer.invoke('projectSpec:approve', projectId, version),
    reject: (projectId: string, version: number): Promise<void> =>
      ipcRenderer.invoke('projectSpec:reject', projectId, version),
    history: (projectId: string): Promise<ProjectSpecification[]> =>
      ipcRenderer.invoke('projectSpec:history', projectId),
    list: (): Promise<ProjectSpecification[]> => ipcRenderer.invoke('projectSpec:list'),
    onCouncilEvent: (cb: (e: CouncilRunEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CouncilRunEvent): void => cb(payload)
      ipcRenderer.on('projectSpec:councilEvent', listener)
      return (): void => {
        ipcRenderer.removeListener('projectSpec:councilEvent', listener)
      }
    },
    onGenerated: (cb: (e: ProjectSpecGeneratedEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: ProjectSpecGeneratedEnvelope): void => cb(payload)
      ipcRenderer.on('projectSpec:generated', listener)
      return (): void => {
        ipcRenderer.removeListener('projectSpec:generated', listener)
      }
    },
    getWorkingDirectory: (projectId: string): Promise<string | undefined> =>
      ipcRenderer.invoke('projectSpec:getWorkingDirectory', projectId),
    setWorkingDirectory: (req: SetProjectWorkingDirectoryDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('projectSpec:setWorkingDirectory', req)
  },
  taskGraph: {
    generate: (req: GenerateTaskGraphRequestDto): Promise<{ runId: string; projectId: string }> =>
      ipcRenderer.invoke('taskGraph:generate', req),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke('taskGraph:cancel', runId),
    approve: (projectId: string): Promise<void> => ipcRenderer.invoke('taskGraph:approve', projectId),
    reject: (projectId: string): Promise<void> => ipcRenderer.invoke('taskGraph:reject', projectId),
    get: (projectId: string): Promise<TaskGraphSnapshot | undefined> =>
      ipcRenderer.invoke('taskGraph:get', projectId),
    onCouncilEvent: (cb: (e: CouncilRunEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CouncilRunEvent): void => cb(payload)
      ipcRenderer.on('taskGraph:councilEvent', listener)
      return (): void => {
        ipcRenderer.removeListener('taskGraph:councilEvent', listener)
      }
    },
    onGenerated: (cb: (e: TaskGraphGeneratedEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: TaskGraphGeneratedEnvelope): void => cb(payload)
      ipcRenderer.on('taskGraph:generated', listener)
      return (): void => {
        ipcRenderer.removeListener('taskGraph:generated', listener)
      }
    },
    setWorkingDirectory: (req: SetTaskGraphWorkingDirectoryDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:setWorkingDirectory', req),
    getReadyTaskIds: (projectId: string): Promise<string[]> =>
      ipcRenderer.invoke('taskGraph:getReadyTaskIds', projectId),
    execution: (projectId: string): Promise<ProjectExecution> => ipcRenderer.invoke('taskGraph:execution', projectId),
    executionSummary: (projectId: string): Promise<ProjectExecution | undefined> => ipcRenderer.invoke('taskGraph:executionSummary', projectId),
    attemptEvents: (req: { projectId: string; attemptId: string }): Promise<unknown[]> => ipcRenderer.invoke('taskGraph:attemptEvents', req),
    adoptPlan: (projectId: string): Promise<WorktreeActionResult> => ipcRenderer.invoke('taskGraph:adoptPlan', projectId),
    configure: (projectId: string, commands: CommandSpec[], maxAttempts: number, budget?: TaskBudget): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:configure', projectId, commands, maxAttempts, budget),
    setTaskBudget: (projectId: string, taskId: string, budget: TaskBudget): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:setTaskBudget', projectId, taskId, budget),
    finalReview: (projectId: string): Promise<WorktreeActionResult> => ipcRenderer.invoke('taskGraph:finalReview', projectId),
    runReadyTasks: (req: RunTaskGraphTaskDto): Promise<WorktreeActionResult> => ipcRenderer.invoke('taskGraph:runReadyTasks', req),
    release: (projectId: string, commit: string): Promise<WorktreeActionResult> => ipcRenderer.invoke('taskGraph:release', projectId, commit),
    respondPermission: (req: RespondPermissionRequestDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:respondPermission', req),
    respondInstall: (req: RespondInstallRequestDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:respondInstall', req),
    runTask: (req: RunTaskGraphTaskDto): Promise<TaskGraphRunResult> =>
      ipcRenderer.invoke('taskGraph:runTask', req),
    abortTask: (projectId: string, taskId: string): Promise<void> =>
      ipcRenderer.invoke('taskGraph:abortTask', { projectId, taskId }),
    acceptTask: (req: AcceptOrDiscardTaskDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:acceptTask', req),
    discardTask: (req: AcceptOrDiscardTaskDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('taskGraph:discardTask', req),
    onTaskEvent: (cb: (e: TaskGraphTaskEventEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: TaskGraphTaskEventEnvelope): void => cb(payload)
      ipcRenderer.on('taskGraph:taskEvent', listener)
      return (): void => {
        ipcRenderer.removeListener('taskGraph:taskEvent', listener)
      }
    }
  },
  changeRequest: {
    list: (projectId: string): Promise<ChangeRequest[]> => ipcRenderer.invoke('changeRequest:list', projectId),
    updateProposal: (req: UpdateChangeRequestProposalDto): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('changeRequest:updateProposal', req),
    evaluate: (req: EvaluateChangeRequestDto): Promise<{ runId: string; error?: string }> =>
      ipcRenderer.invoke('changeRequest:evaluate', req),
    cancel: (runId: string): Promise<void> => ipcRenderer.invoke('changeRequest:cancel', runId),
    approve: (projectId: string, id: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('changeRequest:approve', { projectId, id }),
    reject: (projectId: string, id: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('changeRequest:reject', { projectId, id }),
    linkSpec: (projectId: string, id: string, specVersion: number): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('changeRequest:linkSpec', { projectId, id, specVersion }),
    apply: (projectId: string, id: string): Promise<WorktreeActionResult> =>
      ipcRenderer.invoke('changeRequest:apply', { projectId, id }),
    onCouncilEvent: (cb: (e: CouncilRunEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: CouncilRunEvent): void => cb(payload)
      ipcRenderer.on('changeRequest:councilEvent', listener)
      return (): void => {
        ipcRenderer.removeListener('changeRequest:councilEvent', listener)
      }
    },
    onEvaluated: (cb: (e: ChangeRequestEvaluatedEnvelope) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: ChangeRequestEvaluatedEnvelope): void => cb(payload)
      ipcRenderer.on('changeRequest:evaluated', listener)
      return (): void => {
        ipcRenderer.removeListener('changeRequest:evaluated', listener)
      }
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
