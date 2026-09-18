import { applicationRuns } from '../services/run-lifecycle'
import { recordCouncilUsage } from './usage-store'
import { withCompanyTruth } from './company-truth-format'
import { listCompanyFacts } from './company-truth-store'
import { ipcMain, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { ProviderId } from '@ai-council/shared'
import { runCouncil } from '@ai-council/council-core'
import { ensureProjectRepository } from '@ai-council/coding'
import type { CodingExecutor } from '@ai-council/coding'
import type { ProjectSpecification } from '@ai-council/project-domain'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { BackendConfig } from './backend-config'
import { createParticipantFactory } from './participant-factory'
import { buildProjectSpecPrompt, isProjectSpecParseError, parseProjectSpecJson } from './project-spec-format'
import { appendEvent, listProjectIds, replayProject } from './project-event-log'
import { readProjectDirectory, writeProjectDirectory } from './project-directory-store'
import type { CodingExecutorId, GenerateSpecRequestDto, ProjectSpecGeneratedEnvelope, SetProjectWorkingDirectoryDto, WorktreeActionResult } from './ipc-types'

export function registerProjectSpecIpcHandlers(
  getWindow: () => BrowserWindow | null,
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig,
  executors: Record<CodingExecutorId, CodingExecutor>,
  backendConfig: BackendConfig
): void {
  const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
  const activeRuns = new Map<string, AbortController>()
  const activeProjects = new Set<string>()

  ipcMain.handle('projectSpec:generate', async (_e, req: GenerateSpecRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '', projectId: '' }

    const projectId = req.projectId ?? randomUUID()
    if (activeProjects.has(projectId)) throw new Error('Für dieses Projekt wird bereits eine Spezifikation erstellt.')
    activeProjects.add(projectId)
    try {
      const existingVersions = req.projectId ? replayProject(req.projectId) : []
      const latest = existingVersions[existingVersions.length - 1] as ProjectSpecification | undefined
      const version = (latest?.version ?? 0) + 1

      await appendEvent(projectId, {
        projectId, type: 'SpecificationDrafted', timestamp: Date.now(), payload: { version, goal: req.goal }
      })

      // A project's real working directory (if one has been set - see
      // project-directory-store.ts, settable from project creation onward),
      // so local-agent council seats can actually read the project's code
      // instead of always running in the empty app-owned scratch directory.
      const workingDirectory = readProjectDirectory(projectId)
      const providers = await buildParticipant.prepare(req.providers, workingDirectory)
      const controller = new AbortController()
      const run = recordCouncilUsage(runCouncil({
        deliberation: req.deliberation === 'compact' ? 'compact' : 'full',
        providers,
        chairId: req.chairId,
        request: { messages: [{ role: 'user', content: withCompanyTruth(buildProjectSpecPrompt(req.goal, latest, req.userNote, req.planningProfile === 'simple' ? 'simple' : 'standard'), listCompanyFacts()) }] },
        options: { signal: controller.signal }
      }), { kind: 'specification', projectId: projectId, workingDirectory: workingDirectory }, controller.signal)
      activeRuns.set(run.runId, controller)

      void applicationRuns.track(() => controller.abort(), async (): Promise<void> => {
        let synthesisText = ''
        let actualChairId: ProviderId = req.chairId
        try {
          for await (const event of run.events) {
            if (!win.isDestroyed()) win.webContents.send('projectSpec:councilEvent', event)
            if (event.kind === 'provider_event' && event.stage === 'synthesis' && event.event.type === 'done') {
              synthesisText = event.event.result.text
              actualChairId = event.providerId
            }
          }

          if (controller.signal.aborted) throw new Error('Spezifikationserstellung abgebrochen.')
          const parsed = parseProjectSpecJson(synthesisText)
          let envelope: ProjectSpecGeneratedEnvelope

          if (isProjectSpecParseError(parsed)) {
            // Same reasoning as task-graph-ipc.ts: an abort before synthesis
            // completed looks identical to a bad model response otherwise.
            envelope = {
              projectId,
              ok: false,
              error: controller.signal.aborted ? 'Abgebrochen, bevor eine vollständige Antwort vorlag.' : parsed.error,
              rawText: parsed.rawText
            }
          } else {
            const now = Date.now()
            const spec: ProjectSpecification = {
              id: projectId,
              version,
              supersedesVersion: latest?.version,
              goal: req.goal,
              requirements: parsed.requirements,
              nonGoals: parsed.nonGoals,
              architectureNotes: parsed.architectureNotes,
              risks: parsed.risks,
              openQuestions: parsed.openQuestions,
              chairId: actualChairId,
              rawSynthesisText: synthesisText,
              status: 'council_generated',
              createdAt: now,
              updatedAt: now
            }
            envelope = { projectId, ok: true, spec }

            await appendEvent(projectId, {
              projectId,
              type: 'SpecificationCouncilGenerated',
              timestamp: now,
              payload: spec
            })

          }

          if (!win.isDestroyed()) win.webContents.send('projectSpec:generated', envelope)
        } catch (err) {
          // See task-graph-ipc.ts's identical catch for why this matters: an
          // uncaught throw here previously crashed this fire-and-forget task
          // silently (UnhandledPromiseRejectionWarning) and left the renderer
          // waiting forever for a result that would never arrive.
          const envelope: ProjectSpecGeneratedEnvelope = {
            projectId,
            ok: false,
            error: `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`,
            rawText: synthesisText
          }
          if (!win.isDestroyed()) win.webContents.send('projectSpec:generated', envelope)
        } finally {
          activeRuns.delete(run.runId)
          activeProjects.delete(projectId)
        }
      }).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))

      return { runId: run.runId, projectId }
    } catch (err) {
      activeProjects.delete(projectId)
      throw err
    }
  })

  ipcMain.handle('projectSpec:cancel', (_e, runId: string) => {
    activeRuns.get(runId)?.abort()
  })

  ipcMain.handle('projectSpec:approve', async (_e, projectId: string, version: number): Promise<void> => {
    const versions = replayProject(projectId)
    const candidate = versions.find(v => v.version === version)
    if (!candidate || candidate.status !== 'council_generated') throw new Error('Keine freigabef?hige Spezifikation.')
    await appendEvent(projectId, {
      projectId,
      type: 'SpecificationHumanApproved',
      timestamp: Date.now(),
      payload: { version }
    })
    for (const previous of versions.filter(v => v.status === 'human_approved' && v.version !== version)) {
      await appendEvent(projectId, { projectId, type: 'SpecificationSuperseded', timestamp: Date.now(), payload: { version: previous.version } })
    }
  })

  ipcMain.handle('projectSpec:reject', async (_e, projectId: string, version: number): Promise<void> => {
    await appendEvent(projectId, {
      projectId,
      type: 'SpecificationRejected',
      timestamp: Date.now(),
      payload: { version }
    })
  })

  ipcMain.handle(
    'projectSpec:history',
    (_e, projectId: string): ProjectSpecification[] => replayProject(projectId)
  )

  ipcMain.handle('projectSpec:list', (): ProjectSpecification[] =>
    listProjectIds()
      .map((id) => replayProject(id))
      .map((versions) => versions[versions.length - 1])
      .filter((v): v is ProjectSpecification => v !== undefined)
  )

  ipcMain.handle('projectSpec:getWorkingDirectory', (_e, projectId: string): string | undefined => readProjectDirectory(projectId))

  ipcMain.handle('projectSpec:setWorkingDirectory', async (_e, req: SetProjectWorkingDirectoryDto): Promise<WorktreeActionResult> => {
    try {
      const workingDirectory = await ensureProjectRepository(req.workingDirectory)
      writeProjectDirectory(req.projectId, workingDirectory)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
