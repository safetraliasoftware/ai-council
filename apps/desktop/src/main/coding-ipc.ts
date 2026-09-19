import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  mergeWorktree,
  discardWorktree
} from '@ai-council/coding'
import type { CodingExecutor, ExecutorAvailability } from '@ai-council/coding'
import type {
  CodingDetectResult,
  CodingExecutorId,
  CodingRunRecord,
  HistoryListEntry,
  StartCodingTaskDto,
  RunWorkflowResult,
  WorktreeActionResult,
  WorkflowRunRecord
} from './ipc-types'
import { appendRun, getRun, listRuns, getWorkflowWorktree } from './run-history-store'
import { installExecutor, loginExecutor } from './local-agent-setup'
import { WorktreeStore } from './worktree-store'
import { applicationRuns } from '../services/run-lifecycle'
import { executionPreflight } from './preflight'
import { saveUsage } from './usage-store'
import type { UsageRecord } from './usage-store'
import type { CodingExecutorEvent } from '@ai-council/coding'
import type { ProviderId } from '@ai-council/shared'

/**
 * Deliberately separate from ipc.ts (the Council/AIProvider IPC surface).
 * Coding executors are a different kind of thing - agentic runtimes with
 * filesystem/shell access and their own process lifecycle - and keeping
 * their wiring in its own module keeps that boundary visible in the code,
 * not just in the package layout.
 *
 * `executors` is constructed once in index.ts and passed in here (and,
 * separately, into the participant-factory for CouncilParticipant use) -
 * both consumers share the same instances rather than each constructing
 * their own, which matters because each executor's task/session state is
 * scoped per instance.
 */
export function registerCodingIpcHandlers(
  getWindow: () => BrowserWindow | null,
  executors: Record<CodingExecutorId, CodingExecutor>
): void {
  function send(win: BrowserWindow, channel: string, payload: unknown): void {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }

  ipcMain.handle('coding:detect', async (_e, executorId: CodingExecutorId): Promise<CodingDetectResult> => {
    const availability = await executors[executorId].detect()
    return availability
  })

  ipcMain.handle(
    'coding:detectAll',
    async (): Promise<Record<CodingExecutorId, ExecutorAvailability>> => {
      const ids = Object.keys(executors) as CodingExecutorId[]
      const entries = await Promise.all(ids.map(async (id) => [id, await executors[id].detect()] as const))
      return Object.fromEntries(entries) as Record<CodingExecutorId, ExecutorAvailability>
    }
  )

  ipcMain.handle('coding:installExecutor', (_e, executorId: CodingExecutorId): { ok: boolean; error?: string } =>
    installExecutor(executorId)
  )

  ipcMain.handle('coding:loginExecutor', (_e, executorId: CodingExecutorId): { ok: boolean; error?: string } =>
    loginExecutor(executorId)
  )

  ipcMain.handle('coding:pickDirectory', async (): Promise<string | undefined> => {
    const win = getWindow()
    if (!win) return undefined
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })

  function forward(win: BrowserWindow, executorId: CodingExecutorId, handle: { taskId: string; events: AsyncIterable<CodingExecutorEvent> }, controller: AbortController, usage: UsageRecord): void {
    void applicationRuns.track(() => controller.abort(), async () => {
      const call = usage.calls[0]
      let done = false
      try {
        for await (const event of handle.events) {
          if (event.type === 'text') call.outputChars += event.text.length
          if (event.type === 'done') {
            done = true
            call.outputChars = Math.max(call.outputChars, event.summary.length)
            for (const field of ['inputTokens', 'outputTokens', 'costUsd'] as const) {
              const value = event[field]
              if (typeof value === 'number' && Number.isFinite(value) && value >= 0) call[field] = value
            }
            call.outcome = 'completed'
            saveUsage(usage)
          }
          if (event.type === 'error') { call.outcome = 'failed'; done = false }
          send(win, 'coding:event', { executorId, taskId: handle.taskId, event })
        }
      } catch (err) {
        // Same underlying issue as the workflow loop above: an uncaught
        // throw here previously crashed this task silently and left the
        // renderer waiting forever for a terminal event.
        console.error(`Coding task ${handle.taskId} (${executorId}) failed unexpectedly:`, err)
        send(win, 'coding:event', {
          executorId,
          taskId: handle.taskId,
          event: { type: 'error', message: `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}` }
        })
      } finally {
        call.outcome = controller.signal.aborted ? 'cancelled' : done ? 'completed' : 'failed'
        usage.status = call.outcome
        usage.finishedAt = Date.now()
        call.durationMs = usage.finishedAt - usage.startedAt
        saveUsage(usage)
      }
    }).catch(error => console.error('Coding-Verbrauch konnte nicht gespeichert werden:', error))
  }

  // Coding is the direct, single-agent workspace - the user works with one
  // chosen agent (any permission tier, up to full shell access) in a real
  // directory across a running session (startTask + resumeSession
  // follow-ups). This is deliberately separate from the Workflow tab's
  // governed multi-agent pipeline (isolated worktree, review, accept/
  // discard) - the two areas serve different, intentional purposes, not one
  // superseding the other. A handler returning an empty taskId (rather than
  // throwing) matches the same "never started" convention already used by
  // every other handler here (see the `if (!win)` checks below) - an
  // uncaught throw from a synchronous ipcMain.handle would otherwise reject
  // the renderer's invoke() promise uncaught, leaving "Läuft…" stuck
  // forever with nothing visible (caught live).
  async function startCoding(req: StartCodingTaskDto & { sessionId?: string }) {
    const win = getWindow()
    if (!win) return { taskId: '' }
    let usage: UsageRecord | undefined
    try {
      applicationRuns.assertRunning()
      const executor = executors[req.executorId]
      if (!executor) throw new Error('Unbekannter Coding-Agent.')
      if (req.sessionId && !executor.resumeSession) throw new Error('Dieser Agent unterstützt keine Sitzungsfortsetzung.')
      await executionPreflight(req.workingDirectory, [], [executor], false, req.permissionTier !== 'read-only')
      applicationRuns.assertRunning()
      const providerIds: Record<CodingExecutorId, ProviderId> = { 'claude-code-cli': 'anthropic', 'openai-codex-cli': 'openai', 'google-antigravity-cli': 'gemini', 'grok-build-cli': 'xai' }
      usage = { runId: randomUUID(), kind: 'coding', workingDirectory: req.workingDirectory, startedAt: Date.now(), status: 'running', calls: [{
        providerId: providerIds[req.executorId], backend: 'local_agent', inputChars: req.prompt.length, outputChars: 0, durationMs: 0, outcome: 'running'
      }] }
      saveUsage(usage)
      const controller = new AbortController()
      const spec = { prompt: req.prompt, workingDirectory: req.workingDirectory, permissionTier: req.permissionTier }
      const handle = req.sessionId ? executor.resumeSession!(req.sessionId, spec, { signal: controller.signal }) : executor.startTask(spec, { signal: controller.signal })
      forward(win, req.executorId, handle, controller, usage)
      return { taskId: handle.taskId }
    } catch (error) {
      if (usage) { usage.status = 'failed'; usage.calls[0].outcome = 'failed'; usage.finishedAt = Date.now(); saveUsage(usage) }
      return { taskId: '', error: error instanceof Error ? error.message : String(error) }
    }
  }
  ipcMain.handle('coding:startTask', (_e, req: StartCodingTaskDto) => startCoding(req))
  ipcMain.handle('coding:resumeSession', (_e, req: StartCodingTaskDto & { sessionId: string }) => startCoding(req))

  ipcMain.handle('coding:abort', (_e, req: { executorId: CodingExecutorId; taskId: string }) => {
    executors[req.executorId].abort(req.taskId)
  })

  const workflowControllers = new Map<string, AbortController>()
  const activeWorktrees = new WorktreeStore(app.getPath('userData'), getWorkflowWorktree)

  ipcMain.handle('coding:runWorkflow', async (): Promise<RunWorkflowResult> => ({
    workflowId: '', error: 'Neue Implementierungen starten im Bereich Projekt-Spezifikation nach Freigabe von Spec, Taskgraph und Prüfprofil. Dieser Bereich zeigt weiterhin ältere Läufe.'
  }))

  ipcMain.handle('coding:abortWorkflow', (_e, workflowId: string) => {
    workflowControllers.get(workflowId)?.abort()
  })

  ipcMain.handle('coding:mergeWorktree', async (_e, workflowId: string): Promise<WorktreeActionResult> => {
    try {
      const worktree = activeWorktrees.get(workflowId)
      if (!worktree) {
        return {
          ok: false,
          error: 'Kein aktiver Worktree für diesen Lauf gefunden (evtl. schon übernommen, verworfen oder entfernt).'
        }
      }
      await mergeWorktree(worktree)
      // Only untracked on success - a failed merge leaves the worktree
      // itself intact (see mergeWorktree's doc), so keep it tracked here
      // too, or a retry after the user resolves what blocked it would
      // find nothing to merge.
      activeWorktrees.delete(workflowId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('coding:discardWorktree', async (_e, workflowId: string): Promise<WorktreeActionResult> => {
    try {
      const worktree = activeWorktrees.get(workflowId)
      if (!worktree) {
        return {
          ok: false,
          error: 'Kein aktiver Worktree für diesen Lauf gefunden (evtl. schon übernommen, verworfen oder entfernt).'
        }
      }
      await discardWorktree(worktree)
      activeWorktrees.delete(workflowId)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('history:list', (_e, kind?: 'coding' | 'workflow'): HistoryListEntry[] => listRuns(kind))

  ipcMain.handle('history:get', (_e, id: string) => getRun(id))

  ipcMain.handle('history:saveCodingRun', (_e, record: Omit<CodingRunRecord, 'id' | 'kind'>): { id: string } => {
    const full: CodingRunRecord = { ...record, id: randomUUID(), kind: 'coding' }
    appendRun(full)
    return { id: full.id }
  })

  ipcMain.handle('history:saveWorkflowRun', (_e, record: Omit<WorkflowRunRecord, 'id' | 'kind'>): { id: string } => {
    const full: WorkflowRunRecord = { ...record, id: randomUUID(), kind: 'workflow' }
    appendRun(full)
    return { id: full.id }
  })
}
