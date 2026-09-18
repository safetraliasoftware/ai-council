import { applicationRuns } from '../services/run-lifecycle'
import { recordCouncilUsage } from './usage-store'
import { withCompanyTruth } from './company-truth-format'
import { listCompanyFacts } from './company-truth-store'
import { ipcMain, BrowserWindow } from 'electron'
import type { ProviderId } from '@ai-council/shared'
import { runCouncil } from '@ai-council/council-core'
import { ensureProjectRepository, detectVerificationProfileFromDirectory, detectVerificationProfileFromText } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import { TaskGraph } from '@ai-council/task-graph'
import type { ExecutionTask } from '@ai-council/task-graph'
import type { TaskGraphSnapshot } from '@ai-council/project-domain'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { BackendConfig } from './backend-config'
import { createParticipantFactory } from './participant-factory'
import { buildTaskGraphPrompt, isTaskGraphParseError, parseTaskGraphJson } from './task-graph-format'
import { readTaskGraph, writeTaskGraph } from './task-graph-store'
import { readProjectDirectory } from './project-directory-store'
import { replayProject } from './project-event-log'
import { hasExecutionStarted, hasOpenAttempts } from './execution-store'
import type { CodingExecutorId, GenerateTaskGraphRequestDto, TaskGraphGeneratedEnvelope } from './ipc-types'

/**
 * Mirrors project-spec-ipc.ts's shape closely on purpose - same Council
 * mechanism (via createParticipantFactory, same as every other Council
 * caller), same streaming/parse-error/human-gate pattern. The one real
 * difference: parsed tasks are validated through TaskGraph.addTasks() (the
 * Phase 0 engine) before being persisted - no new validation logic, just
 * reusing what's already tested there (cycle detection, unknown references,
 * atomic all-or-nothing commit).
 */
export function registerTaskGraphIpcHandlers(
  getWindow: () => BrowserWindow | null,
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig,
  executors: Record<CodingExecutorId, CodingExecutor>,
  backendConfig: BackendConfig
): void {
  const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
  const activeRuns = new Map<string, AbortController>()
  const activeProjects = new Set<string>()

  function assertReplaceable(projectId: string, specVersion: number): void {
    if (hasOpenAttempts(projectId)) {
      throw new Error('Offene Ausführungsversuche zuerst abschließen oder verwerfen.')
    }
    if (hasExecutionStarted(projectId) && readTaskGraph(projectId)?.specVersion === specVersion) {
      throw new Error('Ein gestarteter Taskgraph wird nicht überschrieben. Bitte zuerst die Spezifikation kontrolliert überarbeiten.')
    }
  }

  ipcMain.handle('taskGraph:generate', async (_e, req: GenerateTaskGraphRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '', projectId: req.projectId }
    if (activeProjects.has(req.projectId)) throw new Error('Für dieses Projekt wird bereits ein Taskgraph erstellt.')
    activeProjects.add(req.projectId)
    try {
      const versions = replayProject(req.projectId)
      const spec = versions.find((v) => v.version === req.specVersion)
      if (!spec || spec.status !== 'human_approved') {
        throw new Error('Die Spezifikation muss zuerst genehmigt werden.')
      }
      const current = readTaskGraph(req.projectId)
      assertReplaceable(req.projectId, req.specVersion)

      // Resolve once, reused below both to ground the council's local-agent
      // seats in the real project code and (on success) to persist onto the
      // new snapshot - prefers an already-established taskgraph directory,
      // falling back to the directory chosen up front at project creation
      // (project-directory-store.ts), re-validated here since it may have
      // moved/vanished since then. On failure just leave it unset - the
      // council falls back to the scratch directory, and TaskGraphExecution's
      // own "Projektordner einrichten" step is still the fallback UI later.
      let workingDirectory = current?.workingDirectory
      if (!workingDirectory) {
        const early = readProjectDirectory(req.projectId)
        if (early) {
          try { workingDirectory = await ensureProjectRepository(early) } catch { /* leave unset */ }
        }
      }

      const providers = await buildParticipant.prepare(req.providers, workingDirectory)
      const controller = new AbortController()
      const run = recordCouncilUsage(runCouncil({
        deliberation: req.deliberation === 'compact' ? 'compact' : 'full',
        providers,
        chairId: req.chairId,
        request: { messages: [{ role: 'user', content: withCompanyTruth(buildTaskGraphPrompt(spec, req.planningProfile === 'simple' ? 'simple' : 'standard'), listCompanyFacts()) }] },
        options: { signal: controller.signal }
      }), { kind: 'task_graph', projectId: req.projectId, workingDirectory: workingDirectory }, controller.signal)
      activeRuns.set(run.runId, controller)

      void applicationRuns.track(() => controller.abort(), async (): Promise<void> => {
        let synthesisText = ''
        let actualChairId: ProviderId = req.chairId
        try {
          for await (const event of run.events) {
            if (!win.isDestroyed()) win.webContents.send('taskGraph:councilEvent', event)
            if (event.kind === 'provider_event' && event.stage === 'synthesis' && event.event.type === 'done') {
              synthesisText = event.event.result.text
              actualChairId = event.providerId
            }
          }

          if (controller.signal.aborted) throw new Error('Taskgraph-Erstellung abgebrochen.')
          const parsed = parseTaskGraphJson(synthesisText)
          let envelope: TaskGraphGeneratedEnvelope

          if (isTaskGraphParseError(parsed)) {
            // An abort before the synthesis stage completed leaves synthesisText
            // empty, which parses as the same generic "no JSON found" error as a
            // genuinely bad model response - say which one actually happened.
            envelope = {
              projectId: req.projectId,
              ok: false,
              error: controller.signal.aborted ? 'Abgebrochen, bevor eine vollständige Antwort vorlag.' : parsed.error,
              rawText: parsed.rawText
            }
          } else {
            const tasks: ExecutionTask[] = parsed.map((t) => ({ ...t, specVersion: req.specVersion, status: 'pending' }))

            try {
              new TaskGraph().addTasks(tasks)
            } catch (err) {
              envelope = {
                projectId: req.projectId,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
                rawText: synthesisText
              }
              if (!win.isDestroyed()) win.webContents.send('taskGraph:generated', envelope)
              return
            }

            const now = Date.now()
            const snapshot: TaskGraphSnapshot = {
              projectId: req.projectId,
              specVersion: req.specVersion,
              tasks,
              status: 'council_generated',
              chairId: actualChairId,
              rawSynthesisText: synthesisText,
              createdAt: now,
              updatedAt: now
            }
            if (JSON.stringify(readTaskGraph(req.projectId)) !== JSON.stringify(current)) throw new Error('Taskgraph während der Planung verändert. Ergebnis wird nicht automatisch überschrieben.')
            assertReplaceable(req.projectId, req.specVersion)
            if (replayProject(req.projectId).find(v => v.version === req.specVersion)?.status !== 'human_approved') throw new Error('Spezifikation während der Planung geändert.')
            if (workingDirectory) snapshot.workingDirectory = workingDirectory
            // Best-effort Prüfprofil-Vorschlag - nie automatisch übernommen, nur
            // ein besserer Startpunkt für das Formular als ein Node-Default, der
            // für jeden anderen Stack (z.B. .NET, Python, Rust) strukturell nie
            // passen kann. Dateisystem-Erkennung geht vor, da sie auf echten
            // Manifesten beruht statt auf einer Textheuristik.
            const specText = [spec.goal, spec.architectureNotes, ...spec.requirements.map((r) => r.statement)].join(' ')
            const suggestedCommands =
              (workingDirectory && detectVerificationProfileFromDirectory(workingDirectory)) || detectVerificationProfileFromText(specText)
            if (suggestedCommands?.length) snapshot.suggestedCommands = suggestedCommands
            writeTaskGraph(req.projectId, snapshot)
            envelope = { projectId: req.projectId, ok: true, snapshot }
          }

          if (!win.isDestroyed()) win.webContents.send('taskGraph:generated', envelope)
        } catch (err) {
          // A participant/council call throwing instead of yielding an error
          // event (e.g. a synchronous validation failure inside a
          // CouncilParticipant) would otherwise crash this fire-and-forget
          // task silently - Node reports an UnhandledPromiseRejectionWarning
          // and the renderer waits forever for a result that never arrives.
          // Always resolve to something the UI can show and unblock on.
          const envelope: TaskGraphGeneratedEnvelope = {
            projectId: req.projectId,
            ok: false,
            error: `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`,
            rawText: synthesisText
          }
          if (!win.isDestroyed()) win.webContents.send('taskGraph:generated', envelope)
        } finally {
          activeRuns.delete(run.runId)
          activeProjects.delete(req.projectId)
        }
      }).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))

      return { runId: run.runId, projectId: req.projectId }
    } catch (err) {
      activeProjects.delete(req.projectId)
      throw err
    }
  })

  ipcMain.handle('taskGraph:cancel', (_e, runId: string) => {
    activeRuns.get(runId)?.abort()
  })

  ipcMain.handle('taskGraph:approve', (_e, projectId: string): void => {
    const snapshot = readTaskGraph(projectId)
    if (!snapshot) return
    writeTaskGraph(projectId, { ...snapshot, status: 'human_approved', updatedAt: Date.now() })
  })

  ipcMain.handle('taskGraph:reject', (_e, projectId: string): void => {
    const snapshot = readTaskGraph(projectId)
    if (!snapshot) return
    writeTaskGraph(projectId, { ...snapshot, status: 'rejected', updatedAt: Date.now() })
  })

  ipcMain.handle(
    'taskGraph:get',
    (_e, projectId: string): TaskGraphSnapshot | undefined => readTaskGraph(projectId)
  )
}
