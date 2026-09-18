import { applicationRuns } from '../services/run-lifecycle'
import { recordCouncilUsage } from './usage-store'
import { ipcMain, BrowserWindow } from 'electron'
import { runCouncil } from '@ai-council/council-core'
import type { CodingExecutor } from '@ai-council/coding'
import type { ChangeRequest } from '@ai-council/project-domain'
import { ElectronSecretStore } from './secret-store'
import { ModelConfig } from './model-config'
import { BackendConfig } from './backend-config'
import { createParticipantFactory } from './participant-factory'
import { buildChangeRequestReviewPrompt, parseChangeRequestVerdict } from './change-request-format'
import { readTaskGraph } from './task-graph-store'
import { appendEvent, replayChangeRequests, replayProject } from './project-event-log'
import { withCompanyTruth } from './company-truth-format'
import { listCompanyFacts } from './company-truth-store'
import type { ProjectEngine } from '../services/project-engine'
import type {
  CodingExecutorId,
  EvaluateChangeRequestDto,
  ChangeRequestEvaluatedEnvelope,
  UpdateChangeRequestProposalDto,
  WorktreeActionResult
} from './ipc-types'

/**
 * Sibling of task-graph-ipc.ts, mirroring its shape (Council via
 * createParticipantFactory, same streaming/parse-error/human-gate pattern),
 * but for the ChangeRequest lifecycle instead of taskgraph generation. The
 * actual targeted-revalidation work happens in ProjectEngine.applyChangeRequest
 * - this file only owns the CR's own record and its narrow Council
 * evaluation call, sharing the SAME ProjectEngine instance
 * task-graph-execution-ipc.ts already constructed (passed in), never a
 * second one, so busy/controller/state tracking never splits.
 */
export function registerChangeRequestIpcHandlers(
  getWindow: () => BrowserWindow | null,
  secretStore: ElectronSecretStore,
  modelConfig: ModelConfig,
  executors: Record<CodingExecutorId, CodingExecutor>,
  backendConfig: BackendConfig,
  engine: ProjectEngine
): void {
  const buildParticipant = createParticipantFactory(secretStore, modelConfig, executors, backendConfig)
  const activeRuns = new Map<string, AbortController>()
  // CR ids with an evaluation currently in flight - status alone can't tell
  // updateProposal to block during this window, since a CR stays 'pending'
  // for the entire duration of the council run (only becoming
  // 'council_approved' once it finishes). Without this, editing the
  // proposal mid-evaluation persists silently: the council's rationale ends
  // up describing a proposal that's no longer the one a human actually
  // approves afterward. Caught in a self-review.
  const evaluatingIds = new Set<string>()
  const proposalWrites = new Map<string, Promise<unknown>>()
  const requestKey = (projectId: string, id: string): string => `${projectId}:${id}`

  async function action(fn: () => Promise<void>): Promise<WorktreeActionResult> {
    try {
      await fn()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  ipcMain.handle('changeRequest:list', (_e, projectId: string): ChangeRequest[] => replayChangeRequests(projectId))

  ipcMain.handle('changeRequest:updateProposal', (_e, req: UpdateChangeRequestProposalDto) =>
    action(async () => {
      // The UI only ever shows this editable while status is 'pending', but
      // that's not enforced here server-side - guard it directly, so the
      // proposal content a human later approves can't silently change
      // underneath an already-decided ChangeRequest. Caught in a
      // self-review.
      const key = requestKey(req.projectId, req.id)
      if (evaluatingIds.has(key)) throw new Error('Vorschlag kann während einer laufenden Rat-Bewertung nicht geändert werden.')
      const cr = replayChangeRequests(req.projectId).find((r) => r.id === req.id)
      if (!cr) throw new Error('Änderungsanfrage nicht gefunden.')
      if (cr.status !== 'pending') throw new Error('Vorschlag kann nach Rat-Bewertung nicht mehr geändert werden.')
      const write = appendEvent(req.projectId, {
        projectId: req.projectId,
        type: 'ChangeRequestProposalUpdated',
        timestamp: Date.now(),
        payload: { id: req.id, proposedChanges: req.proposedChanges, severity: req.severity }
      })
      proposalWrites.set(key, write)
      try { await write }
      finally { if (proposalWrites.get(key) === write) proposalWrites.delete(key) }
    })
  )

  ipcMain.handle('changeRequest:evaluate', async (_e, req: EvaluateChangeRequestDto) => {
    const win = getWindow()
    if (!win) return { runId: '' }

    const key = requestKey(req.projectId, req.id)
    if (evaluatingIds.has(key)) return { runId: '' }
    evaluatingIds.add(key)
    try {
      // A blur-triggered autosave may still be appending to the journal.
      await proposalWrites.get(key)
      const cr = replayChangeRequests(req.projectId).find((r) => r.id === req.id)
      if (!cr || cr.status !== 'pending') throw new Error('Nur offene Änderungsanfragen können bewertet werden.')
      if (!req.providers.length || new Set(req.providers).size !== req.providers.length || !req.providers.includes(req.chairId)) {
        throw new Error('Bitte Teilnehmer und einen zugehörigen Vorsitz auswählen.')
      }
      const graph = readTaskGraph(req.projectId)
      const spec = graph ? replayProject(req.projectId).find((s) => s.version === graph.specVersion) : undefined
      if (!graph || !spec) throw new Error('Taskgraph oder Spezifikation fehlt.')
      if (req.proposal) {
        if (typeof req.proposal.proposedChanges !== 'string' || !['minor', 'architecture', 'security', 'compliance'].includes(req.proposal.severity)) {
          throw new Error('Ungültiger Änderungsvorschlag.')
        }
        await appendEvent(req.projectId, {
          projectId: req.projectId, type: 'ChangeRequestProposalUpdated', timestamp: Date.now(),
          payload: { id: req.id, proposedChanges: req.proposal.proposedChanges, severity: req.proposal.severity }
        })
        cr.proposedChanges = req.proposal.proposedChanges
        cr.severity = req.proposal.severity
      }
      const affectedTasks = graph.tasks.filter((t) => cr.affectedTaskIds.includes(t.id))

      // Same reasoning as project-spec-ipc.ts/task-graph-ipc.ts: ground local-
      // agent council seats in the real project code, not the empty scratch
      // directory, whenever the taskgraph already has one.
      const providers = await buildParticipant.prepare(req.providers, graph.workingDirectory)
      const controller = new AbortController()
      const run = recordCouncilUsage(runCouncil({
        providers,
        chairId: req.chairId,
        request: { messages: [{ role: 'user', content: withCompanyTruth(buildChangeRequestReviewPrompt(cr, spec, affectedTasks), listCompanyFacts()) }] },
        options: { signal: controller.signal }
      }), { kind: 'change_request', projectId: req.projectId, workingDirectory: graph.workingDirectory }, controller.signal)
      activeRuns.set(run.runId, controller)

      void applicationRuns.track(() => controller.abort(), async (): Promise<void> => {
        let synthesisText = ''
        try {
          for await (const event of run.events) {
            if (!win.isDestroyed()) win.webContents.send('changeRequest:councilEvent', event)
            if (event.kind === 'provider_event' && event.stage === 'synthesis' && event.event.type === 'done') {
              synthesisText = event.event.result.text
            }
          }

          let envelope: ChangeRequestEvaluatedEnvelope
          try {
            if (controller.signal.aborted) throw new Error('Abgebrochen, bevor eine vollständige Antwort vorlag.')
            const verdict = parseChangeRequestVerdict(synthesisText)
            await appendEvent(req.projectId, {
              projectId: req.projectId,
              type: 'ChangeRequestCouncilEvaluated',
              timestamp: Date.now(),
              payload: { id: req.id, councilRationale: verdict.rationale, councilRecommendation: verdict.recommendation }
            })
            envelope = { projectId: req.projectId, id: req.id, ok: true, ...verdict }
          } catch (err) {
            envelope = {
              projectId: req.projectId,
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              rawText: synthesisText
            }
          }

          if (!win.isDestroyed()) win.webContents.send('changeRequest:evaluated', envelope)
        } catch (err) {
          // Same fix already applied to every other streaming IPC loop in this
          // app: an uncaught throw here would crash this fire-and-forget task
          // silently and leave the renderer waiting forever for a result.
          const envelope: ChangeRequestEvaluatedEnvelope = {
            projectId: req.projectId,
            id: req.id,
            ok: false,
            error: `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`,
            rawText: synthesisText
          }
          if (!win.isDestroyed()) win.webContents.send('changeRequest:evaluated', envelope)
        } finally {
          activeRuns.delete(run.runId)
          evaluatingIds.delete(key)
        }
      }).catch(error => console.error('Lauf konnte nicht abgeschlossen werden:', error))

      return { runId: run.runId }
    } catch (err) {
      evaluatingIds.delete(key)
      throw err
    }
  })

  ipcMain.handle('changeRequest:cancel', (_e, runId: string) => {
    activeRuns.get(runId)?.abort()
  })

  ipcMain.handle('changeRequest:approve', (_e, req: { projectId: string; id: string }) =>
    action(async () => {
      if (evaluatingIds.has(requestKey(req.projectId, req.id))) throw new Error('Die Rat-Bewertung läuft noch.')
      const cr = replayChangeRequests(req.projectId).find(r => r.id === req.id)
      if (!cr || cr.status !== 'council_approved') throw new Error('Die Änderungsanfrage muss zuerst vom Rat bewertet werden.')
      await appendEvent(req.projectId, { projectId: req.projectId, type: 'ChangeRequestHumanApproved', timestamp: Date.now(), payload: { id: req.id } })
    })
  )

  ipcMain.handle('changeRequest:reject', (_e, req: { projectId: string; id: string }) =>
    action(async () => {
      if (evaluatingIds.has(requestKey(req.projectId, req.id))) throw new Error('Die Rat-Bewertung läuft noch.')
      const cr = replayChangeRequests(req.projectId).find((r) => r.id === req.id)
      await appendEvent(req.projectId, { projectId: req.projectId, type: 'ChangeRequestRejected', timestamp: Date.now(), payload: { id: req.id } })
      // Rejecting the CR means "no spec change needed" - but the escalated
      // attempt that raised it is still sitting there. 'escalated' is
      // terminal in TaskGraph's own transition table (no automatic way
      // out), so without this a human had to reject here AND separately
      // remember to go discard that attempt themselves - easy to miss, and
      // exactly what looked live like "the rejection isn't taking effect"
      // (the task stayed stuck at "Architekturentscheidung erforderlich").
      if (cr) {
        const state = await engine.get(req.projectId)
        for (const taskId of cr.affectedTaskIds) {
          const latest = [...state.attempts].reverse().find((a) => a.taskId === taskId)
          if (latest?.status === 'escalated') await engine.discard(req.projectId, taskId).catch(() => {})
        }
      }
    })
  )

  ipcMain.handle('changeRequest:linkSpec', (_e, req: { projectId: string; id: string; specVersion: number }) =>
    action(async () => {
      const cr = replayChangeRequests(req.projectId).find((r) => r.id === req.id)
      if (!cr) throw new Error('Änderungsanfrage nicht gefunden.')
      if (cr.status !== 'human_approved') throw new Error('Verknüpfung erfordert eine genehmigte Änderungsanfrage.')
      if (cr.appliedAt !== undefined) throw new Error('Eine angewendete Änderungsanfrage kann nicht neu verknüpft werden.')
      const versions = replayProject(req.projectId)
      const target = versions.find(s => s.version === req.specVersion)
      if (!Number.isInteger(req.specVersion) || req.specVersion < 1 || !target || target.status !== 'human_approved') {
        throw new Error('Bitte eine vorhandene, genehmigte Spezifikationsversion auswählen.')
      }
      // Repair invalid legacy links, but keep a usable link stable while apply may consume it.
      if (cr.resultingSpecVersion !== undefined && versions.some(s => s.version === cr.resultingSpecVersion && s.status === 'human_approved')) {
        throw new Error('Bereits mit einer gültigen Spezifikationsversion verknüpft.')
      }
      await appendEvent(req.projectId, {
        projectId: req.projectId,
        type: 'ChangeRequestLinkedToSpec',
        timestamp: Date.now(),
        payload: { id: req.id, specVersion: req.specVersion }
      })
    })
  )

  ipcMain.handle('changeRequest:apply', (_e, req: { projectId: string; id: string }) =>
    action(() => engine.applyChangeRequest(req.projectId, req.id))
  )
}
