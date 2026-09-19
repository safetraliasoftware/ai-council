import { ipcMain, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProviderId } from '@ai-council/shared'
import { ensureProjectRepository } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import type { CommandSpec, TaskBudget } from '@ai-council/project-domain'
import { ProjectEngine } from '../services/project-engine'
import { executionPreflight } from './preflight'
import { readTaskGraph, writeTaskGraph } from './task-graph-store'
import { appendEvent, replayProject, replayChangeRequests } from './project-event-log'
import { loadExecution, saveExecution, recordAttemptEvent, getExecutionSummary, getAttemptEvents } from './execution-store'
import { buildTaskExecutionPrompt } from './task-graph-execution-prompt'
import { withCompanyTruth } from './company-truth-format'
import { listCompanyFacts } from './company-truth-store'
import type { CodingExecutorId, RespondInstallRequestDto, RespondPermissionRequestDto, RunTaskGraphTaskDto, WorktreeActionResult } from './ipc-types'

export function registerTaskGraphExecutionIpcHandlers(
  getWindow: () => BrowserWindow | null,
  executors: Record<CodingExecutorId, CodingExecutor>,
  council: (prompt: string, signal: AbortSignal, chairId?: ProviderId, workingDirectory?: string, projectId?: string, kind?: 'final_review' | 'replanning') => Promise<string>
): ProjectEngine {
  const engine = new ProjectEngine({
    preflight: async (directory, commands, ids) => {
      const selected = ids.map(id => {
        const executor = executors[id as CodingExecutorId]
        if (!executor) throw new Error(`Unbekannter Coding-Agent: ${id}`)
        return executor
      })
      await executionPreflight(directory, commands, selected)
    },
    worktreesRoot: join(app.getPath('userData'), 'worktrees'), graph: readTaskGraph,
    spec: (id, version) => replayProject(id).find(s => s.version === version),
    load: loadExecution, save: saveExecution,
    saveGraph: async (id, graph) => { writeTaskGraph(id, graph) },
    changeRequest: (id, crId) => replayChangeRequests(id).find(cr => cr.id === crId),
    openChangeRequest: async (id, cr) => {
      // Dedup: don't spam a new CR if one already covers this exact task and is still undecided.
      const existing = replayChangeRequests(id).find(
        (r) => (r.status === 'pending' || r.status === 'council_approved') && r.affectedTaskIds.some((t) => cr.affectedTaskIds.includes(t))
      )
      if (existing) return
      await appendEvent(id, {
        projectId: id, type: 'ChangeRequestOpened', timestamp: Date.now(),
        payload: { ...cr, id: randomUUID(), createdAt: Date.now(), status: 'pending' }
      })
    },
    markChangeRequestApplied: async (id, crId) => {
      await appendEvent(id, { projectId: id, type: 'ChangeRequestApplied', timestamp: Date.now(), payload: { id: crId } })
    },
    record: recordAttemptEvent,
    executor: id => { const executor = executors[id as CodingExecutorId]; if (!executor) throw new Error('Unbekannter Coding-Agent.'); return executor },
    context: (id, taskId) => {
      const graph = readTaskGraph(id)!
      const spec = replayProject(id).find(s => s.version === graph.specVersion)!
      return withCompanyTruth(buildTaskExecutionPrompt(graph.tasks.find(t => t.id === taskId)!, spec), listCompanyFacts())
    },
    council,
    emit: (projectId, taskId, workflowId, event) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send('taskGraph:taskEvent', { projectId, taskId, workflowId, event })
    }
  })
  async function action(fn: () => Promise<void>): Promise<WorktreeActionResult> {
    try { await fn(); return { ok: true } } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }
  ipcMain.handle('taskGraph:setWorkingDirectory', (_e, req: { projectId: string; workingDirectory: string }) => action(async () => {
    const graph = readTaskGraph(req.projectId)
    if (!graph) throw new Error('Taskgraph fehlt.')
    const state = await engine.get(req.projectId)
    if (state.integration || state.attempts.length) throw new Error('Arbeitsverzeichnis eines gestarteten Projektlaufs kann nicht geändert werden.')
    const workingDirectory = await ensureProjectRepository(req.workingDirectory)
    writeTaskGraph(req.projectId, { ...graph, workingDirectory, updatedAt: Date.now() })
  }))
  ipcMain.handle('taskGraph:execution', (_e, id: string) => engine.get(id))
  // Read directly from the store, bypassing engine.get()'s structuredClone
  // of the full in-memory state (which still accumulates every attempt's
  // full event history in RAM for ProjectEngine's own use) - this is what
  // the UI's 1.5s poll actually needs, and what removes the CPU cost that
  // was pinning the main process. taskGraph:execution above is kept for
  // call sites that genuinely need the full state (e.g. right after an
  // action).
  ipcMain.handle('taskGraph:executionSummary', (_e, id: string) => getExecutionSummary(id))
  ipcMain.handle('taskGraph:attemptEvents', (_e, req: { projectId: string; attemptId: string }) => getAttemptEvents(req.projectId, req.attemptId))
  ipcMain.handle('taskGraph:adoptPlan', (_e, id: string) => action(() => engine.adoptApprovedPlan(id)))
  ipcMain.handle('taskGraph:configure', (_e, id: string, commands: CommandSpec[], maxAttempts: number, budget?: TaskBudget) => action(() => engine.configure(id, commands, maxAttempts, budget)))
  ipcMain.handle('taskGraph:setTaskBudget', (_e, id: string, taskId: string, budget: TaskBudget) => action(() => engine.setTaskBudget(id, taskId, budget)))
  ipcMain.handle('taskGraph:getReadyTaskIds', async (_e, id: string) => {
    await engine.get(id)
    const graph = readTaskGraph(id)
    return graph?.tasks.filter(t => ['pending', 'failed'].includes(t.status) && t.dependencies.every(d => graph.tasks.find(t => t.id === d.taskId)?.status === 'accepted')).map(t => t.id) ?? []
  })
  ipcMain.handle('taskGraph:runTask', async (_e, req: RunTaskGraphTaskDto) => {
    try { return await engine.start(req.projectId, req.taskId, req) }
    catch (err) { return { workflowId: '', error: err instanceof Error ? err.message : String(err) } }
  })
  ipcMain.handle('taskGraph:abortTask', (_e, req: { projectId: string }) => engine.abort(req.projectId))
  ipcMain.handle('taskGraph:acceptTask', (_e, req: { projectId: string; taskId: string }) => action(() => engine.accept(req.projectId, req.taskId)))
  ipcMain.handle('taskGraph:discardTask', (_e, req: { projectId: string; taskId: string }) => action(() => engine.discard(req.projectId, req.taskId)))
  ipcMain.handle('taskGraph:finalReview', (_e, id: string) => action(() => engine.finalReview(id)))
  ipcMain.handle('taskGraph:runReadyTasks', (_e, req: RunTaskGraphTaskDto) => action(() => engine.runReadyTasks(req.projectId, req)))
  ipcMain.handle('taskGraph:release', (_e, id: string, commit: string) => action(() => engine.release(id, commit)))
  ipcMain.handle('taskGraph:respondPermission', (_e, req: RespondPermissionRequestDto) =>
    action(() => engine.respondToPermissionRequest(req.projectId, req.attemptId, req.granted)))
  ipcMain.handle('taskGraph:respondInstall', (_e, req: RespondInstallRequestDto) =>
    action(() => engine.respondToInstallRequest(req.projectId, req.attemptId, req.decision)))
  return engine
}
