import { createHash, randomUUID } from 'node:crypto'
import type { ProviderId } from '@ai-council/shared'
import { requireApprovedSpecification, requireVerifiedAttempt, requireReleaseReady, checkScope, canResumeTaskCorrection, canRecheckReviewWorkspace } from '@ai-council/project-domain'
import type { ProjectExecution, TaskAttempt, CommandSpec, Verdict, ProjectSpecification, TaskGraphSnapshot, ChangeRequest } from '@ai-council/project-domain'
import { createWorktree, ensureProjectRepository, discardWorktree, gitOutput,
  fingerprintWorkspace, snapshotWorkspace, runVerification, parseReviewVerdict, REVIEW_CONTRACT, captureGitDiff, parsePermissionDenialWarning,
  suggestToolInstallCommand, refreshWindowsPath, verifyWorkspaceUnchanged } from '@ai-council/coding'
import type { CodingExecutor, WorkflowEvent, WorkflowStage, PermissionTier } from '@ai-council/coding'
import { TaskGraph } from '@ai-council/task-graph'
import type { ExecutionTask } from '@ai-council/task-graph'
import { buildReplacementTaskPrompt, parseReplacementTasks } from '../main/change-request-format'
import { checksForPrompt, correctionEvidence, previousAttemptsSummary } from './workflow-evidence'
import { DEFAULT_TASK_BUDGET } from '@ai-council/project-domain'
import type { TaskBudget, TaskRuntime } from '@ai-council/project-domain'
import { classifyTaskFailure, TaskControlError, validateTaskBudget } from './task-control'

export interface EngineeringPorts {
  preflight?(workingDirectory: string | undefined, commands: CommandSpec[], executorIds: string[]): Promise<void>
  worktreesRoot: string
  graph(projectId: string): TaskGraphSnapshot | undefined
  spec(projectId: string, version: number): ProjectSpecification | undefined
  load(projectId: string): ProjectExecution | undefined
  save(state: ProjectExecution, graph: TaskGraphSnapshot, reason: string): Promise<void>
  /** Persists a taskgraph mutation with no associated TaskAttempt (e.g. applyChangeRequest) - bypasses save()'s attempt-status projection entirely. */
  saveGraph(projectId: string, graph: TaskGraphSnapshot, reason: string): Promise<void>
  changeRequest(projectId: string, id: string): ChangeRequest | undefined
  /** Opens (or, if one already covers the same task and is still undecided, reuses) a ChangeRequest - dedup is the port implementation's responsibility. */
  openChangeRequest(projectId: string, cr: Omit<ChangeRequest, 'id' | 'createdAt' | 'status'>): Promise<void>
  markChangeRequestApplied(projectId: string, id: string): Promise<void>
  context(projectId: string, taskId: string): string
  executor(id: string): CodingExecutor
  /** workingDirectory grounds local-agent council seats in a real directory instead of the empty app-owned scratch dir - see finalReview()/applyChangeRequest()'s call sites for what they pass. */
  council(prompt: string, signal: AbortSignal, chairId?: ProviderId, workingDirectory?: string, projectId?: string, kind?: 'final_review' | 'replanning'): Promise<string>
  emit(projectId: string, taskId: string, attemptId: string, event: WorkflowEvent): void
  record?(projectId: string, attemptId: string, event: WorkflowEvent): Promise<void>
}
export interface RunRoles { implementerId: string; reviewerId: string; challengerId?: string; recheckWorkspace?: boolean }

/** Host-independent engineering application service. All effects enter via ports or coding adapters. */
export class ProjectEngine {
  private stopping = false
  private persistenceFailure: unknown
  private busy = new Set<string>()
  private controllers = new Map<string, AbortController>()
  private states = new Map<string, ProjectExecution>()
  private schedulers = new Set<string>()
  private stopRequested = new Set<string>()
  /** Resolved by respondToPermissionRequest(); lost on restart just like `controllers` - get()'s recovery below treats that the same as an abandoned 'running' attempt. */
  private permissionRequests = new Map<string, (granted: boolean) => void>()
  /** Resolved by respondToInstallRequest(); same restart-recovery treatment as permissionRequests above. */
  private installRequests = new Map<string, (decision: { approved: boolean; command?: CommandSpec }) => void>()
  constructor(private ports: EngineeringPorts) {}

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const id of this.schedulers) this.stopRequested.add(id)
    for (const controller of this.controllers.values()) controller.abort()
    while (this.busy.size || this.schedulers.size) await new Promise(resolve => setTimeout(resolve, 25))
    if (this.persistenceFailure) {
      for (const id of this.states.keys()) await this.save(id, 'ShutdownRetry')
      this.persistenceFailure = undefined
    }
  }

  private assertRunning(): void {
    if (this.stopping) throw new Error('Das Programm wird beendet. Neue Projektaktionen sind gesperrt.')
  }

  private graph(id: string): TaskGraphSnapshot {
    const graph = this.ports.graph(id)
    if (!graph) throw new Error('Kein Taskgraph vorhanden.')
    return graph
  }
  private state(id: string): ProjectExecution {
    let state = this.states.get(id)
    if (!state) {
      const graph = this.graph(id)
      state = this.ports.load(id) ?? { projectId: id, runId: randomUUID(), specVersion: graph.specVersion,
        phase: 'planning', commands: [], maxAttempts: 3, attempts: [], updatedAt: Date.now() }
      this.states.set(id, state)
    }
    return state
  }
  private async save(id: string, reason: string): Promise<void> {
    const state = this.state(id)
    state.updatedAt = Date.now()
    await this.ports.save(state, this.graph(id), reason)
  }
  private approved(id: string): void {
    const graph = this.graph(id)
    requireApprovedSpecification(this.ports.spec(id, graph.specVersion), graph)
    if (this.state(id).specVersion !== graph.specVersion) throw new Error('Der Ausführungsplan gehört zu einer anderen Spec-Version. Änderungsprüfung erforderlich.')
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.assertRunning()
    if (this.busy.has(id)) throw new Error('Für dieses Projekt läuft bereits eine Aktion.')
    this.busy.add(id)
    try { return await action() } finally { this.busy.delete(id) }
  }
  private async cancellable<T>(id: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.exclusive(id, async () => {
      const controller = new AbortController()
      this.controllers.set(id, controller)
      try { return await action(controller.signal) }
      finally { this.controllers.delete(id) }
    })
  }
  async get(id: string): Promise<ProjectExecution> {
    const state = this.state(id)
    if (!this.busy.has(id) && state.attempts.some(a => a.status === 'running' || a.status === 'awaiting_permission' || a.status === 'awaiting_install')) {
      for (const attempt of state.attempts) if (attempt.status === 'running' || attempt.status === 'awaiting_permission' || attempt.status === 'awaiting_install') {
        attempt.status = 'interrupted'
        attempt.pendingPermissionActions = undefined
        attempt.pendingInstallAction = undefined
        attempt.error = 'Lauf unterbrochen. Alter Worktree bleibt erhalten; ein neuer Versuch verwendet einen neuen Worktree.'
      }
      state.phase = 'halted'
      state.haltReason = 'Unterbrochener Lauf nach Programmneustart.'
      await this.save(id, 'RunInterrupted')
    }
    return structuredClone(state)
  }
  async configure(id: string, commands: CommandSpec[], maxAttempts: number, budget?: TaskBudget): Promise<void> {
    await this.exclusive(id, async () => {
      if (budget) validateTaskBudget(budget)
      if (!Array.isArray(commands) || !commands.length || commands.length > 20 ||
          commands.some(c => !c || typeof c.executable !== 'string' || !c.executable.trim() || !Array.isArray(c.args) ||
            c.args.some(a => typeof a !== 'string') || !Number.isFinite(c.timeoutMs) || c.timeoutMs < 100 || c.timeoutMs > 3600000) ||
          !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error('Ungültiges Prüfprofil oder Versuchslimit.')
      const state = this.state(id)
      if (state.phase === 'done') throw new Error('Dieser Projektlauf wurde bereits freigegeben.')
      if (state.attempts.some(a => a.commit && a.status !== 'accepted')) throw new Error('Offene Integration zuerst abschließen, bevor das Prüfprofil geändert wird.')
      state.commands = structuredClone(commands)
      state.maxAttempts = maxAttempts
      if (budget) state.budget = structuredClone(budget)
      state.releaseCommit = undefined; state.finalVerdict = undefined; state.finalVerification = undefined
      for (const a of state.attempts) if (a.status === 'review') { a.status = 'failed'; a.error = 'Prüfprofil geändert. Erneute Prüfung nötig.' }
      state.phase = 'execution'
      await this.save(id, 'VerificationProfileHumanApproved')
    })
  }
  async setTaskBudget(id: string, taskId: string, budget: TaskBudget): Promise<void> {
    await this.exclusive(id, async () => {
      validateTaskBudget(budget)
      if (!this.graph(id).tasks.some(task => task.id === taskId)) throw new Error('Task nicht gefunden.')
      const state = this.state(id)
      if (state.phase === 'done') throw new Error('Dieser Projektlauf wurde bereits freigegeben.')
      const previous = state.taskBudgets
      state.taskBudgets = { ...previous, [taskId]: structuredClone(budget) }
      try { await this.save(id, 'TaskBudgetHumanApproved') }
      catch (err) { state.taskBudgets = previous; throw err }
    })
  }

  async adoptApprovedPlan(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      const graph = this.graph(id), state = this.state(id)
      requireApprovedSpecification(this.ports.spec(id, graph.specVersion), graph)
      if (graph.specVersion === state.specVersion) throw new Error('Dieser Plan ist bereits aktiv.')
      // Must match execution-store.ts's hasOpenAttempts() "open" definition
      // exactly: 'awaiting_install' and 'paused' are also non-terminal pause
      // states. Archiving one below (state.archivedAttempts = ...) without
      // blocking on it first would make it permanently unreachable -
      // discard()/hasOpenAttempts() never look at archivedAttempts.
      if (state.attempts.some(a => a.status === 'running' || a.status === 'awaiting_permission' || a.status === 'review' || a.status === 'awaiting_install' || a.status === 'paused')) throw new Error('Offene Versuche zuerst beenden oder verwerfen.')
      if (state.phase === 'done') {
        if (!state.releaseCommit) throw new Error('Der Commit des vorherigen Releases fehlt.')
        // The next iteration starts from our released commit. Do not adopt an
        // arbitrary current HEAD: external target-branch changes must still be detected.
        state.sourceHead = state.releaseCommit
      }
      state.archivedAttempts = [...(state.archivedAttempts ?? []), ...state.attempts]
      state.attempts = []; state.specVersion = graph.specVersion; state.runId = randomUUID()
      state.phase = 'execution'; state.haltReason = undefined; state.releaseCommit = undefined
      state.finalVerdict = undefined; state.finalVerification = undefined
      await this.save(id, 'RevisedPlanHumanApproved')
    })
  }
  /**
   * Targeted counterpart to adoptApprovedPlan(): that one is a wholesale
   * reset (archives every attempt, regenerates every task with fresh IDs).
   * This one touches only what a specific ChangeRequest actually affects -
   * built entirely on TaskGraph's own tested invalidateDownstream/
   * updateTask primitives instead of asking an LLM to re-derive the
   * dependency cascade. See engineering-store.ts's saveExecution() for the
   * matching fix that stops it from being silently undone by the next
   * unrelated save.
   */
  async applyChangeRequest(id: string, changeRequestId: string): Promise<void> {
    await this.cancellable(id, async signal => {
      const cr = this.ports.changeRequest(id, changeRequestId)
      if (!cr) throw new Error('Änderungsanfrage nicht gefunden.')
      if (cr.status !== 'human_approved') throw new Error('Änderungsanfrage ist noch nicht freigegeben.')
      if (!cr.resultingSpecVersion) throw new Error('Änderungsanfrage ist noch keiner Spezifikationsversion zugeordnet.')
      if (cr.appliedAt) throw new Error('Änderungsanfrage wurde bereits angewendet.')
      const newSpec = this.ports.spec(id, cr.resultingSpecVersion)
      if (!newSpec || newSpec.status !== 'human_approved') throw new Error('Die verknüpfte Spezifikationsversion ist noch nicht genehmigt.')

      const state = this.state(id)
      if (state.attempts.some(a => a.status === 'running' || a.status === 'awaiting_permission' || a.status === 'review' || a.status === 'awaiting_install' || a.status === 'paused')) throw new Error('Offene Versuche zuerst beenden oder verwerfen.')

      const graph = this.graph(id)

      // Crash-recovery: if a previous call got as far as saving the graph at
      // the new spec version but crashed before finishing (state save and/or
      // markChangeRequestApplied), cr.appliedAt is still unset above, so a
      // retry would otherwise reach this point and re-run the domain
      // migration - which is NOT idempotent (it would ask the council for a
      // second, duplicate set of replacement tasks for already-invalidated
      // tasks). Detect that the graph is already migrated and skip straight
      // to finishing the remaining steps instead.
      //
      // Matching graph.specVersion alone is NOT enough to identify a crash
      // recovery for THIS changeRequestId - a second, unrelated CR can
      // legitimately target the very same already-current resultingSpecVersion
      // (e.g. a human links two CRs to the same revised spec), and that
      // second CR's own invalidation/replacement work would then be silently
      // skipped entirely. Caught in a self-review. Bind the check to this
      // CR's own affected tasks instead - invalidateTask() unconditionally
      // sets 'invalidated' on every one of them, so this is a reliable,
      // CR-specific completion marker.
      const migrationAlreadyDone = cr.affectedTaskIds.length > 0 &&
        cr.affectedTaskIds.every(taskId => graph.tasks.find(t => t.id === taskId)?.status === 'invalidated')
      if (graph.specVersion === cr.resultingSpecVersion && migrationAlreadyDone) {
        state.specVersion = cr.resultingSpecVersion
        this.resumeAfterChangeRequest(state)
        await this.save(id, 'ChangeRequestApplied')
        await this.ports.markChangeRequestApplied(id, changeRequestId)
        return
      }

      const domain = new TaskGraph()
      domain.addTasks(graph.tasks)

      // Tasks already 'invalidated' (with a replacement already recorded)
      // from an earlier, unrelated ChangeRequest must not be swept into
      // THIS one's replacement request - found while writing a regression
      // test for the crash-recovery fix above: a second CR would otherwise
      // ask the council to replace tasks that were already resolved,
      // failing with "no replacement task for <old, already-resolved id>".
      const alreadyResolvedIds = new Set(
        graph.tasks.filter(t => t.status === 'invalidated' && t.replacedByTaskId?.length).map(t => t.id)
      )

      const directlyAffected = cr.affectedTaskIds.map(taskId => domain.getTask(taskId)).filter((t): t is ExecutionTask => !!t)
      for (const task of directlyAffected) {
        // invalidateDownstream() only ever touches DEPENDENTS of the given
        // id, never the id itself - the directly-affected task (whatever
        // its prior status: 'escalated', or 'accepted' if a human named it
        // explicitly) needs its own explicit invalidation too, otherwise it
        // would sit there permanently 'accepted'/'escalated' while a brand
        // new replacement task exists alongside it, which is ambiguous.
        domain.invalidateTask(task.id, cr.reason)
        domain.invalidateDownstream(task.id, cr.reason)
      }
      const needsReplacement = domain.getAllTasks().filter(t => t.status === 'invalidated' && !alreadyResolvedIds.has(t.id))

      if (needsReplacement.length) {
        const resultingSpecVersion = cr.resultingSpecVersion
        const prompt = buildReplacementTaskPrompt(needsReplacement, newSpec, cr)
        const replacementText = await this.ports.council(prompt, signal, graph.chairId, graph.workingDirectory, id, 'replanning')
        if (signal.aborted) throw new Error('Abgebrochen.')
        const drafts = parseReplacementTasks(replacementText, needsReplacement.map(t => t.id))
        const covered = new Set(drafts.map(d => d.replacesTaskId))
        const missing = needsReplacement.filter(t => !covered.has(t.id))
        if (missing.length) throw new Error(`Ersatz-Tasks unvollständig - kein Ersatz-Task für: ${missing.map(t => t.id).join(', ')}.`)
        const replacements: ExecutionTask[] = drafts.map(({ replacesTaskId: _replacesTaskId, ...task }) => ({
          ...task, specVersion: resultingSpecVersion, status: 'pending'
        }))
        domain.addTasks(replacements)
        // Grouped by replacesTaskId, not one updateTask() call per draft -
        // the Council's prompt explicitly allows splitting one invalidated
        // task into several replacements, and updateTask() replaces the
        // field rather than appending to it, so calling it once per draft
        // silently dropped all but the last replacement. Caught in a
        // self-review.
        const replacedBy = new Map<string, string[]>()
        for (const draft of drafts) replacedBy.set(draft.replacesTaskId, [...(replacedBy.get(draft.replacesTaskId) ?? []), draft.id])
        for (const [replacesTaskId, replacementIds] of replacedBy) domain.updateTask(replacesTaskId, { replacedByTaskId: replacementIds })

        // Re-wire every dependent (old tasks and the freshly-added
        // replacements alike) off a replaced id onto every one of its
        // replacements.
        for (const task of domain.getAllTasks()) {
          for (const dep of task.dependencies) {
            const oldTask = domain.getTask(dep.taskId)
            if (oldTask?.replacedByTaskId?.length && (oldTask.status === 'invalidated' || oldTask.status === 'escalated')) {
              domain.removeDependency(task.id, dep.taskId)
              for (const replacementId of oldTask.replacedByTaskId) {
                domain.addDependency(task.id, { taskId: replacementId, impact: dep.impact })
              }
            }
          }
        }
      }

      // Unaffected pending siblings keep their id and status, but must be
      // re-stamped to the new spec version - canRun() requires an exact
      // specVersion match, so without this they'd become permanently
      // unready even though nothing about them actually changed.
      for (const task of domain.getAllTasks()) {
        if (task.status === 'pending' && task.specVersion !== cr.resultingSpecVersion) {
          domain.updateTask(task.id, { specVersion: cr.resultingSpecVersion })
        }
      }

      graph.specVersion = cr.resultingSpecVersion
      graph.tasks = domain.getAllTasks()
      await this.ports.saveGraph(id, graph, 'ChangeRequestApplied')

      // markChangeRequestApplied is last and treated as the durable "fully
      // done" marker - see the crash-recovery check above, which relies on
      // it still being unset if anything before this point failed.
      state.specVersion = cr.resultingSpecVersion
      this.resumeAfterChangeRequest(state)
      await this.save(id, 'ChangeRequestApplied')
      await this.ports.markChangeRequestApplied(id, changeRequestId)
    })
  }
  private resumeAfterChangeRequest(state: ProjectExecution): void {
    if (state.phase === 'done') {
      if (!state.releaseCommit) throw new Error('Der Commit des vorherigen Releases fehlt.')
      state.sourceHead = state.releaseCommit
      state.runId = randomUUID()
    }
    state.phase = 'execution'
    state.haltReason = undefined
    state.releaseCommit = undefined
    state.finalVerdict = undefined
    state.finalVerification = undefined
  }

  async start(id: string, taskId: string, roles: RunRoles, fromScheduler = false): Promise<{ workflowId: string }> {
    this.assertRunning()
    if (this.busy.has(id) || (this.schedulers.has(id) && !fromScheduler)) throw new Error('Für dieses Projekt läuft bereits eine Aktion.')
    const state = await this.get(id)
    this.assertRunning()
    if (this.busy.has(id) || (this.schedulers.has(id) && !fromScheduler)) throw new Error('Für dieses Projekt läuft bereits eine Aktion.')
    if (state.phase === 'done') throw new Error('Projektlauf bereits freigegeben.')
    this.approved(id)
    const current = this.state(id)
    if (!current.commands.length) throw new Error('Bitte zuerst Test-/Build-Befehle freigeben.')
    const graph = this.graph(id)
    await this.ports.preflight?.(graph.workingDirectory, current.commands,
      [roles.implementerId, roles.reviewerId, roles.challengerId].filter((value): value is string => !!value))
    this.assertRunning()
    if (this.busy.has(id) || (this.schedulers.has(id) && !fromScheduler)) throw new Error('Für dieses Projekt läuft bereits eine Aktion.')
    const task = graph.tasks.find(t => t.id === taskId)
    if (!task) throw new Error('Task oder Abhängigkeiten sind nicht bereit.')
    // Dependency readiness applies to a revalidation start exactly like any
    // other start - previously this check only ran in the non-revalidation
    // branch below, so a task could be revalidated before its own
    // (possibly also-invalidated) dependencies were actually re-accepted.
    // Caught in a self-review.
    if (task.status === 'accepted' || task.dependencies.some(d => graph.tasks.find(t => t.id === d.taskId)?.status !== 'accepted')) {
      throw new Error('Task oder Abhängigkeiten sind nicht bereit.')
    }
    // Every guard that can still reject this start - including the
    // needs_revalidation transition below, which persists a real mutation -
    // must run BEFORE that mutation, not after. Previously the
    // needs_revalidation -> in_progress transition (and its saveGraph())
    // ran first: if the attempt-limit check below then threw, the graph was
    // left with task.status stuck at 'in_progress' with no attempt to match
    // it. The very next unrelated save() (e.g. configure() raising the
    // limit) would then run its generic attempt-status projection against
    // that orphaned 'in_progress' status (saveExecution()'s skip-guard only
    // covers 'invalidated'/'needs_revalidation', not this corrupted
    // in-between state) and derive the status from the task's OLD, already-
    // accepted attempt - silently marking it 'accepted' again with no new
    // check ever having run. Caught in a self-review.
    const previous = current.attempts.filter(a => a.taskId === taskId)
    if (previous.some(a => a.status === 'review' || a.status === 'running' || a.status === 'awaiting_permission' || a.status === 'awaiting_install')) throw new Error('Vorherigen Versuch zuerst prüfen oder verwerfen.')
    if (previous.some(a => a.status === 'escalated')) throw new Error('Architektur-Eskalation erfordert eine überarbeitete Spezifikation.')
    if (previous.some(a => a.commit && a.status !== 'accepted')) throw new Error('Eine Integration dieses Tasks ist offen. Bitte deren Prüfung wiederholen, bevor ein neuer Versuch startet.')
    const retry = previous.at(-1)
    const recheck = roles.recheckWorkspace === true
    if (recheck && !canRecheckReviewWorkspace(retry, graph.specVersion)) throw new Error('Dieser Arbeitsstand kann nicht als abgebrochene Review-Prüfung fortgesetzt werden.')
    const resumeReview = recheck || (retry?.status === 'failed' && retry.reviewPending && retry.worktree && retry.taskStartCommit && retry.specVersion === graph.specVersion)
    const resumePaused = retry?.status === 'paused' && retry.runtime?.retryable && retry.specVersion === graph.specVersion && !retry.commit
    const resumeFix = canResumeTaskCorrection(retry, graph.specVersion) || (resumePaused && retry.runtime?.checkpoint === 'fix')
    const resumeAttempt = resumeReview || resumeFix || resumePaused
    if (!resumeAttempt && previous.length >= current.maxAttempts) throw new Error('Versuchslimit erreicht. Prüfprofil/Limits bewusst anpassen.')
    for (const executorId of [roles.implementerId, roles.reviewerId, roles.challengerId].filter(Boolean)) this.ports.executor(executorId!)
    if (task.status === 'needs_revalidation') {
      // Soft-invalidated by a ChangeRequest - canRun()/getReadyTaskIds() never
      // surface these (only 'pending' does, deliberately), so this is the
      // only way back in: drive the transition explicitly through the real
      // TaskGraph (needs_revalidation -> in_progress is a legal transition),
      // then the normal implement/review cycle below runs unchanged and
      // lands on accepted/failed/escalated exactly like any other attempt.
      const domain = new TaskGraph()
      domain.addTasks(graph.tasks)
      domain.markInProgress(taskId)
      graph.tasks = domain.getAllTasks()
      // Persist this transition together with the new attempt below. An
      // intervening await would let a second start pass the project lock.
    }
    const attempt: TaskAttempt = resumeAttempt ? retry! : { id: randomUUID(), taskId, specVersion: graph.specVersion, startedAt: Date.now(),
      status: 'running', ...roles, verification: [], reviews: [], events: [] }
    if (resumeAttempt) {
      attempt.implementerId = roles.implementerId
      attempt.reviewerId = roles.reviewerId
      attempt.challengerId = roles.challengerId
    }
    attempt.status = 'running'; attempt.error = undefined; attempt.finishedAt = undefined
    if (recheck) {
      attempt.reviewCheckpoint = undefined
      attempt.reviewPending = true
      attempt.fingerprint = undefined
      attempt.verification = []
      attempt.reviews = []
    }
    if (attempt.runtime) { attempt.runtime.failureKind = undefined; attempt.runtime.retryable = undefined }
    if (resumePaused && attempt.runtime?.checkpoint === 'review') attempt.reviewPending = true
    if (!resumeAttempt) current.attempts.push(attempt)
    current.phase = 'execution'; current.haltReason = undefined
    this.busy.add(id)
    const controller = new AbortController()
    this.controllers.set(id, controller)
    try {
      current.updatedAt = Date.now()
      await this.ports.save(current, graph, 'TaskStarted')
    } catch (err) { this.busy.delete(id); this.controllers.delete(id); attempt.status = 'failed'; throw err }
    void this.execute(id, attempt, controller.signal, !!resumeFix, !!resumePaused).catch(err => { this.persistenceFailure = err; console.error('Persistieren des fehlgeschlagenen Laufs nicht möglich:', err) }).finally(() => {
      this.controllers.delete(id); this.busy.delete(id)
    })
    return { workflowId: attempt.id }
  }
  abort(id: string): void { this.stopRequested.add(id); this.controllers.get(id)?.abort() }

  private taskUsage(id: string, attempt: TaskAttempt) {
    const attempts = this.state(id).attempts.filter(a => a.taskId === attempt.taskId && a.specVersion === attempt.specVersion)
    return { calls: attempts.reduce((n, a) => n + (a.runtime?.calls.length ?? 0), 0),
      activeMs: attempts.reduce((n, a) => n + (a.runtime?.activeMs ?? 0), 0),
      corrections: attempts.reduce((n, a) => n + (a.runtime?.corrections ?? 0), 0) }
  }

  async runReadyTasks(id: string, roles: RunRoles): Promise<void> {
    this.assertRunning()
    if (this.schedulers.has(id) || this.busy.has(id)) throw new Error('Projekt arbeitet bereits.')
    this.approved(id)
    if (!this.state(id).commands.length) throw new Error('Prüfprofil fehlt.')
    this.schedulers.add(id); this.stopRequested.delete(id)
    // The user explicitly authorizes serial integration of verified tasks, never release.
    try { await this.save(id, 'SerialExecutionHumanApproved') }
    catch (err) { this.schedulers.delete(id); throw err }
    void (async () => {
      try {
        while (!this.stopRequested.has(id)) {
          const graph = this.graph(id)
          const state = this.state(id)
          const task = graph.tasks.find(t => t.status === 'pending' && t.dependencies.every(d => graph.tasks.find(t => t.id === d.taskId)?.status === 'accepted'))
          if (!task) break
          await this.start(id, task.id, roles, true)
          while (this.busy.has(id)) await new Promise(resolve => setTimeout(resolve, 100))
          if (this.stopRequested.has(id)) break
          const attempt = [...state.attempts].reverse().find(a => a.taskId === task.id)
          if (attempt?.status !== 'review') break
          await this.accept(id, task.id)
        }
      } catch (err) {
        const state = this.state(id); state.phase = 'halted'; state.haltReason = String(err)
        await this.save(id, 'SchedulerHalted')
      } finally { this.schedulers.delete(id) }
    })().catch(err => console.error('Scheduler persistence failed:', err))
  }

  private async agent(id: string, attempt: TaskAttempt, executorId: string, stage: WorkflowStage, prompt: string,
    readonly: boolean, signal: AbortSignal, tier: PermissionTier = readonly ? 'read-only' : 'read-write', resumeSessionId?: string): Promise<string> {
    if (signal.aborted) throw new Error('Abgebrochen.')
    // Claude Code, Antigravity and Grok Build have no sandboxed middle ground
    // between 'read-write' (no shell at all) and 'full' - real coding work
    // almost always needs at least one shell command, so a plain read-write
    // attempt predictably burns a whole wasted turn (every shell call denied,
    // no real progress) before the reactive elevation ask further below ever
    // triggers. Ask up front instead, for exactly these executors - Codex's
    // read-write tier already maps to a sandboxed shell (workspace-write), so
    // it's excluded; readonly (review/finalReview) calls never reach here.
    // Live-measured: 18 denied tool calls and a wasted implement turn on a
    // real project before this fix. Grok's read-write --tools list also
    // omits run_terminal_command, so the same wasted turn applies there.
    if (!readonly && tier === 'read-write' && (executorId === 'claude-code-cli' || executorId === 'google-antigravity-cli' || executorId === 'grok-build-cli')) {
      const granted = await this.requestPermissionElevation(id, attempt, ['Shell-/Terminal-Befehle'], signal)
      if (signal.aborted) throw new Error('Abgebrochen.')
      attempt.status = 'running'
      attempt.pendingPermissionActions = undefined
      await this.save(id, granted ? 'PermissionGranted' : 'PermissionDenied')
      if (granted) tier = 'full'
    }
    const runtime = attempt.runtime ??= { activeMs: 0, corrections: 0, calls: [] }
    const budget = this.state(id).taskBudgets?.[attempt.taskId] ?? this.state(id).budget ?? DEFAULT_TASK_BUDGET
    const usage = this.taskUsage(id, attempt)
    // Continuation of the same fix (pause-resume, or permission elevation
    // via resumeSession) must not consume another correction slot - the
    // original turn already did. Detect that before overwriting runtime.stage.
    const continuingFix = !readonly && stage === 'fix' && (runtime.stage === 'fix' || !!resumeSessionId)
    runtime.checkpoint = readonly ? 'review' : stage === 'fix' ? 'fix' : 'implement'
    if (usage.calls >= budget.maxCalls) throw new TaskControlError('budget', `Aufrufbudget erreicht (${usage.calls}/${budget.maxCalls}). Budget anpassen und fortsetzen.`)
    if (!readonly && stage === 'fix' && !continuingFix && usage.corrections >= budget.maxCorrections) throw new TaskControlError('budget', `Korrekturbudget erreicht (${usage.corrections}/${budget.maxCorrections}). Budget anpassen und fortsetzen.`)
    runtime.stage = stage
    const path = attempt.worktree!.path
    const before = readonly ? await snapshotWorkspace(path) : undefined
    if (signal.aborted) throw new Error('Abgebrochen.')
    if (this.taskUsage(id, attempt).calls >= budget.maxCalls) throw new TaskControlError('budget', 'Aufrufbudget erreicht. Budget anpassen und fortsetzen.')
    let text = '', streamedText = '', done = false, sessionId: string | undefined, deniedActions: string[] = []
    const executor = this.ports.executor(executorId)
    const spec = { prompt, workingDirectory: path, permissionTier: tier }
    if (!readonly && stage === 'fix' && !continuingFix) runtime.corrections++
    const metric = { id: randomUUID(), executorId, stage, startedAt: Date.now(), outcome: 'running' as 'running' | 'completed' | 'failed', inputChars: prompt.length, outputChars: 0,
      finishedAt: undefined as number | undefined, costUsd: undefined as number | undefined, inputTokens: undefined as number | undefined, outputTokens: undefined as number | undefined }
    runtime.calls.push(metric)
    await this.save(id, 'AgentStarted')
    try {
    const handle = resumeSessionId && executor.resumeSession
      ? executor.resumeSession(resumeSessionId, spec, { signal })
      : executor.startTask(spec, { signal })
    for await (const event of handle.events) {
      const envelope: WorkflowEvent = { kind: 'executor_event', stage, event }
      attempt.events.push(envelope)
      await this.ports.record?.(id, attempt.id, envelope)
      this.ports.emit(id, attempt.taskId, attempt.id, envelope)
      if (event.type === 'text') streamedText += event.text
      if (event.type === 'text') metric.outputChars += event.text.length
      if (event.type === 'done') {
        text = event.summary; done = true; sessionId = event.sessionId
        metric.outputChars = Math.max(metric.outputChars, text.length)
        const usage = event as unknown as { costUsd?: number; inputTokens?: number; outputTokens?: number }
        for (const field of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
          if (typeof usage[field] === 'number' && Number.isFinite(usage[field]) && usage[field]! >= 0) metric[field] = usage[field]
        }
      }
      if (event.type === 'error') throw new Error(event.message)
      // Only the implementer's own turns can trigger an elevation offer -
      // the reviewer/finalReview stages are always `readonly` and must stay
      // that way regardless of anything they observe in the stream.
      if (event.type === 'warning' && !readonly) {
        const denied = parsePermissionDenialWarning(event.message)
        if (denied) deniedActions.push(...denied)
      }
    }
    metric.outcome = done && !signal.aborted ? 'completed' : 'failed'
    } catch (err) {
      metric.outcome = 'failed'
      const kind = classifyTaskFailure(err)
      throw new TaskControlError(kind === 'implementation' ? 'process' : kind, err instanceof Error ? err.message : String(err))
    } finally {
      metric.finishedAt = Date.now()
      await this.save(id, 'AgentFinished')
    }
    if (before) {
      const decision = await verifyWorkspaceUnchanged(before, path)
      if (decision.outcome === 'deny') throw new Error(`POLICY VIOLATION: ${decision.reason}`)
      if (decision.toleratedTransient) {
        // The run is allowed to proceed (the deviation was gone by the
        // retry), but stay visible in the attempt's own record instead of
        // vanishing silently - a write that self-reverts within the retry
        // window is otherwise indistinguishable from a benign straggler.
        const envelope: WorkflowEvent = { kind: 'executor_event', stage, event: {
          type: 'warning', message: `Vorübergehende Arbeitsverzeichnis-Abweichung toleriert (verschwand vor der Nachprüfung): ${decision.toleratedTransient}`
        } }
        attempt.events.push(envelope)
        await this.ports.record?.(id, attempt.id, envelope)
        this.ports.emit(id, attempt.taskId, attempt.id, envelope)
      }
    }
      if (!done || signal.aborted) throw new TaskControlError(signal.aborted ? 'cancelled' : 'process', signal.aborted ? 'Abgebrochen.' : 'Agent ohne Abschlussnachricht beendet.')
    await this.save(id, `${stage}Completed`)
    // Bounded to one hop (tier !== 'full'): the resumed call below already
    // runs at the highest tier, so a repeat denial there just falls through
    // to the normal review/fix cycle instead of prompting again.
    if (deniedActions.length && !readonly && sessionId && tier !== 'full') {
      const granted = await this.requestPermissionElevation(id, attempt, deniedActions, signal)
      if (signal.aborted) throw new Error('Abgebrochen.')
      attempt.status = 'running'
      attempt.pendingPermissionActions = undefined
      await this.save(id, granted ? 'PermissionGranted' : 'PermissionDenied')
      if (granted) {
        return await this.agent(id, attempt, executorId, stage,
          `Dir wurde für diesen Task soeben voller Zugriff (inkl. Shell-Befehle) erteilt, nachdem folgende Aktion(en) zuvor verweigert wurden: ${deniedActions.join(', ')}. Bitte schließe die ursprüngliche Aufgabe jetzt vollständig ab.`,
          false, signal, 'full', sessionId)
      }
    }
    return text.trim() ? text : streamedText
  }
  /**
   * Runs one reviewer's finalReview turn (with its own one-shot empty-
   * response retry) and returns its parsed Verdict. Extracted so
   * reviewer/challenger can run concurrently via Promise.all in execute()
   * instead of one after another - each call is fully independent (both
   * are readonly and judge the same already-captured diff/verification).
   */
  private async runReview(id: string, attempt: TaskAttempt, reviewerId: string, prompt: string,
    diff: Awaited<ReturnType<typeof captureGitDiff>>, signal: AbortSignal): Promise<Verdict> {
    // Caught live via the Ablaufprotokoll, twice, with two different
    // triggers - but the same underlying failure mode both times:
    // Antigravity gives up entirely with an empty response the instant ANY
    // single action gets denied, instead of finishing with what its own
    // file tools already found. First trigger: `git status` as a shell
    // command (always denied read-only). Second trigger: it followed a
    // worktree's `.git` file (which is a pointer, not a real directory) out
    // to the main repo's real gitdir to inspect internals like HEAD -
    // outside the `--add-dir`-registered workspace, so its own sandbox
    // denied that too. Neither shell access nor .git archaeology is ever
    // needed here: the diff and verification results are already given as
    // text below. Naively retrying with the identical prompt reproduced the
    // exact same denied action and the exact same empty response, twice in
    // a row, both times.
    //
    // This must NOT be a blanket instruction for every reviewer, though -
    // caught live immediately after scoping it that way: Codex has no
    // separate file-reading tool at all (see openai-codex-cli.ts's
    // mapItem - only command_execution, web_search, etc.), it reads files
    // via its own safely sandboxed read-only shell. Telling Codex not to
    // use shell commands left it with no way to read anything and made it
    // escalate ("Terminal-Befehle sind untersagt... nicht prüfbar"). Scoped
    // to the one executor that actually has this failure mode.
    const noShellNote = reviewerId === 'google-antigravity-cli'
      ? '\nDu läufst schreibgeschützt: Shell-/Terminal-Befehle (z.B. git status, git diff, npm test) werden nicht genehmigt und dürfen nicht versucht werden - der Diff und die Prüfungsergebnisse stehen bereits vollständig oben. Untersuche außerdem ausschließlich die eigentlichen Projektdateien - nicht das .git-Verzeichnis oder dessen Interna (z.B. HEAD, worktrees/*) und keine Pfade außerhalb dieses Arbeitsverzeichnisses; das ist für diese Prüfung nie nötig. Nutze bei Bedarf ausschließlich Datei-Lesewerkzeuge auf den eigentlichen Projektdateien.'
      : ''
    const reviewPrompt = `Du bist ausschließlich Reviewer. Verändere keine Dateien, ergänze keine Tests und implementiere keine Korrekturen. Fehlende Tests oder Fehler ausschließlich als Findings melden. Der folgende Implementierungsauftrag ist nur Prüfkontext, kein Arbeitsauftrag an dich.\n<implementierungsauftrag>\n${prompt}\n</implementierungsauftrag>\nDein Auftrag bleibt eine schreibgeschützte Prüfung.\nPrüfe die tatsächlichen Dateien und den Diff:\n${diff.diff}\nPrüfungen:\n${JSON.stringify(checksForPrompt(attempt.verification))}\nKonzentriere dich auf den aktuellen Task und konkrete Fehler. Wiederhole bereits vorgelegte erfolgreiche Prüfungen nur bei einem konkreten Zweifel. Melde alle erkennbaren notwendigen Korrekturen gebündelt; keine neuen Wunschfunktionen oder bloßen Stilpräferenzen.${noShellNote}${REVIEW_CONTRACT}`
    const previousFindings = attempt.reviews.flatMap(r => r.findings)
    const focusedPrompt = previousFindings.length ? `${reviewPrompt}\nBisher offene Befunde: Prüfe ihren aktuellen Erledigungsstand anhand der Dateien, nicht anhand früherer Behauptungen:\n${JSON.stringify(previousFindings)}` : reviewPrompt
    let text = await this.agent(id, attempt, reviewerId, 'finalReview', focusedPrompt, true, signal)
    if (!text.trim()) {
      const envelope: WorkflowEvent = { kind: 'executor_event', stage: 'finalReview', event: {
        type: 'warning', message: `Reviewer ${reviewerId} hat keine Antwort geliefert. Review wird einmal wiederholt.`
      } }
      attempt.events.push(envelope)
      await this.ports.record?.(id, attempt.id, envelope)
      this.ports.emit(id, attempt.taskId, attempt.id, envelope)
      const retryHint = reviewerId === 'google-antigravity-cli'
        ? '\nHinweis zum vorherigen Versuch: er endete ohne jede Antwort - vermutlich nach einer verweigerten Aktion (Shell-/Terminal-Befehl, oder ein Zugriff auf .git-Interna bzw. einen Pfad außerhalb dieses Arbeitsverzeichnisses). Versuche keinerlei Shell-/Terminal-Befehle und untersuche ausschließlich die eigentlichen Projektdateien in diesem Arbeitsverzeichnis - nichts unter .git und nichts außerhalb davon. Schließe die Prüfung ausschließlich mit den oben stehenden Informationen und Datei-Lesewerkzeugen auf den Projektdateien ab, und liefere in jedem Fall ein Urteil im geforderten JSON-Format.'
        : '\nHinweis zum vorherigen Versuch: er endete ohne jede Antwort. Liefere in jedem Fall ein Urteil im geforderten JSON-Format, auch wenn dafür Annahmen offen bleiben.'
      const retryPrompt = `${focusedPrompt}${retryHint}`
      text = await this.agent(id, attempt, reviewerId, 'finalReview', retryPrompt, true, signal)
      if (!text.trim()) throw new Error(`Reviewer ${reviewerId} hat auch beim zweiten Versuch keine Antwort geliefert. Es liegt kein Review-Urteil vor. Details stehen im Ablaufprotokoll.`)
    }
    return parseReviewVerdict(text)
  }
  /** Pauses the attempt at 'awaiting_permission' until respondToPermissionRequest() resolves it, or the run is aborted. */
  private async requestPermissionElevation(id: string, attempt: TaskAttempt, actions: string[], signal: AbortSignal): Promise<boolean> {
    attempt.status = 'awaiting_permission'
    attempt.pendingPermissionActions = actions
    await this.save(id, 'PermissionRequested')
    const key = `${id}:${attempt.id}`
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => { this.permissionRequests.delete(key); resolve(false) }
      this.permissionRequests.set(key, (granted) => { signal.removeEventListener('abort', onAbort); resolve(granted) })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  async respondToPermissionRequest(id: string, attemptId: string, granted: boolean): Promise<void> {
    const resolve = this.permissionRequests.get(`${id}:${attemptId}`)
    if (!resolve) throw new Error('Keine offene Rechte-Anfrage für diesen Versuch.')
    this.permissionRequests.delete(`${id}:${attemptId}`)
    resolve(granted)
  }
  /** Pauses the attempt at 'awaiting_install' until respondToInstallRequest() resolves it, or the run is aborted. */
  private async requestInstallApproval(id: string, attempt: TaskAttempt, executable: string, suggestedCommand: CommandSpec | undefined, signal: AbortSignal): Promise<{ approved: boolean; command?: CommandSpec }> {
    attempt.status = 'awaiting_install'
    attempt.pendingInstallAction = { executable, suggestedCommand }
    await this.save(id, 'InstallRequested')
    const key = `${id}:${attempt.id}`
    return new Promise((resolve) => {
      const onAbort = (): void => { this.installRequests.delete(key); resolve({ approved: false }) }
      this.installRequests.set(key, (decision) => { signal.removeEventListener('abort', onAbort); resolve(decision) })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  async respondToInstallRequest(id: string, attemptId: string, decision: { approved: false } | { approved: true; command: CommandSpec }): Promise<void> {
    const resolve = this.installRequests.get(`${id}:${attemptId}`)
    if (!resolve) throw new Error('Keine offene Installationsanfrage für diesen Versuch.')
    this.installRequests.delete(`${id}:${attemptId}`)
    resolve(decision)
  }
  private async checks(id: string, cwd: string, signal: AbortSignal): Promise<ReturnType<typeof runVerification> extends Promise<infer T> ? T[] : never> {
    const results = []
    for (const command of this.state(id).commands) {
      const result = await runVerification(command, cwd, signal)
      results.push(result)
      if (!result.success) break
    }
    return results
  }
  private async execute(id: string, attempt: TaskAttempt, signal: AbortSignal, resumeFix = false, resumePaused = false): Promise<void> {
    const state = this.state(id)
    const runtime: TaskRuntime = attempt.runtime ??= { activeMs: 0, corrections: 0, calls: [] }
    const budget = state.taskBudgets?.[attempt.taskId] ?? state.budget ?? DEFAULT_TASK_BUDGET
    let lastTick = Date.now(), lastSave = Date.now(), budgetExceeded = false
    let checkpoint: Promise<void> | undefined
    let persistenceError: unknown
    const accountTime = () => {
      const now = Date.now()
      if (attempt.status === 'running') runtime.activeMs += now - lastTick
      lastTick = now
    }
    const timer = setInterval(() => {
      accountTime()
      if (attempt.status === 'running' && this.taskUsage(id, attempt).activeMs >= budget.maxActiveMs) {
        budgetExceeded = true; this.controllers.get(id)?.abort()
      }
      if (Date.now() - lastSave >= 5000 && !checkpoint) {
        lastSave = Date.now()
        checkpoint = this.save(id, 'RuntimeCheckpoint').catch(err => { persistenceError = err; this.controllers.get(id)?.abort() }).finally(() => { checkpoint = undefined })
      }
    }, 250)
    try {
      if (this.taskUsage(id, attempt).activeMs >= budget.maxActiveMs) throw new TaskControlError('budget', 'Laufzeitbudget erreicht. Budget anpassen und fortsetzen.')
      const graph = this.graph(id)
      if (!graph.workingDirectory) throw new Error('Projektordner fehlt.')
      if (!state.integration) {
        const source = await ensureProjectRepository(graph.workingDirectory)
        state.sourceBranch = (await gitOutput(source, ['symbolic-ref', '--short', 'HEAD'])).trim()
        state.sourceHead = (await gitOutput(source, ['rev-parse', 'HEAD'])).trim()
        state.integration = await createWorktree(source, this.ports.worktreesRoot)
        await this.save(id, 'IntegrationWorkspaceCreated')
      }
      const resumeReview = !!(attempt.reviewPending && attempt.worktree && attempt.taskStartCommit)
      if (!resumeReview && !resumeFix && !(resumePaused && attempt.worktree)) attempt.worktree = await createWorktree(state.integration.path, this.ports.worktreesRoot)
      if (!attempt.worktree) throw new Error('Task-Arbeitsverzeichnis fehlt.')
      await this.save(id, 'TaskWorkspaceCreated')
      // Captured before the implementer ever runs, and used below instead of
      // 'HEAD' at check time - an agent that commits mid-turn (it isn't
      // supposed to, but a 'full'-tier agent with shell access can) would
      // otherwise move HEAD itself, making `git status`/`git diff HEAD`
      // report a clean tree regardless of what it just committed. Caught in
      // a self-review, confirmed live.
      const taskStartCommit = attempt.taskStartCommit ?? (await gitOutput(attempt.worktree!.path, ['rev-parse', 'HEAD'])).trim()
      attempt.taskStartCommit = taskStartCommit
      const context = this.ports.context(id, attempt.taskId)
      const dependencies = graph.tasks.find(t => t.id === attempt.taskId)!.dependencies.map(d => {
        const a = [...state.attempts].reverse().find(a => a.taskId === d.taskId && a.status === 'accepted')
        return { taskId: d.taskId, commit: a?.commit, reviews: a?.reviews.map(r => ({ verdict: r.verdict, findings: r.findings })), checks: a?.verification.map(v => ({ command: v.command, success: v.success })) }
      })
      // Only a genuinely fresh attempt gets this - resumeFix/resumePaused
      // already continue their OWN prior context, they don't need a summary
      // of separate, earlier attempts prepended on top.
      const history = (!resumeFix && !resumePaused)
        ? previousAttemptsSummary(state.attempts.filter(a => a.taskId === attempt.taskId && a.id !== attempt.id))
        : ''
      const prompt = `${context}\nDirekte Dependency-Ergebnisse:\n${JSON.stringify(dependencies)}${history ? `\n${history}` : ''}\nKeine externen Aktionen, kein Push, kein Deployment. Lokale Implementierungsprobleme innerhalb der genehmigten Anforderungen und erlaubten Pfade selbst beheben. Nur notwendige Änderungen verbindlicher Vorgaben oder des erlaubten Bereichs als konkrete Entscheidung melden.`
      attempt.context = prompt
      await this.save(id, 'TaskContextPrepared')
      if (resumeFix) {
        attempt.reviewCheckpoint = undefined
        await this.agent(id, attempt, attempt.implementerId, 'fix', `${prompt}\nSetze den vorhandenen Arbeitsstand fort; beginne nicht von vorn. Behebe die noch offenen Befunde des letzten Reviews und erhalte bereits funktionierende Implementierung und Tests:\n${correctionEvidence(attempt.verification, attempt.reviews)}`, false, signal)
      } else if (!resumeReview) await this.agent(id, attempt, attempt.implementerId, 'implement', `${resumePaused ? 'Setze den vorhandenen Arbeitsstand nach einer technischen Pause fort. Erhalte bereits funktionierenden Code.\n' : ''}${prompt}`, false, signal)
      // Bounded to one offer per execute() call - a repeat "missing" after an
      // approved install just falls through to the normal fix/fail cycle
      // instead of asking again (mirrors the tier !== 'full' bound above).
      let installOffered = false
      // One correction cycle per attempt; retries are separate persisted attempts.
      for (let cycle = 0; cycle < 2; cycle++) {
        runtime.checkpoint = 'review'
        runtime.stage = 'checks'
        attempt.verification = await this.checks(id, attempt.worktree.path, signal)
        await this.save(id, 'VerificationCompleted')
        // A missing executable (spawn ENOENT) is an environment problem, not
        // a code problem - asking the implementer to "fix" it or running a
        // full review cycle against it is pure waste (caught live: both
        // reviewers correctly reported "dotnet not found" twice in a row,
        // costing a full attempt for something a human could resolve in one
        // click). Pause and offer to install it instead, before any review.
        if (!installOffered && attempt.verification.at(-1)?.missingExecutable) {
          installOffered = true
          const missing = attempt.verification.at(-1)!.command.executable
          const decision = await this.requestInstallApproval(id, attempt, missing, suggestToolInstallCommand(missing), signal)
          if (signal.aborted) throw new Error('Abgebrochen.')
          attempt.status = 'running'
          attempt.pendingInstallAction = undefined
          await this.save(id, decision.approved ? 'InstallApproved' : 'InstallDeclined')
          if (decision.approved && decision.command) {
            const installResult = await runVerification(decision.command, attempt.worktree.path, signal)
            const envelope: WorkflowEvent = { kind: 'executor_event', stage: 'implement', event: {
              type: 'warning', message: installResult.success
                ? `Installation von "${missing}" erfolgreich: ${decision.command.executable} ${decision.command.args.join(' ')}`
                : `Installation von "${missing}" fehlgeschlagen (Exit ${installResult.exitCode ?? '–'}): ${installResult.stderr || installResult.stdout}`
            } }
            attempt.events.push(envelope)
            await this.ports.record?.(id, attempt.id, envelope)
            this.ports.emit(id, attempt.taskId, attempt.id, envelope)
            if (installResult.success) await refreshWindowsPath()
            attempt.verification = await this.checks(id, attempt.worktree.path, signal)
            await this.save(id, 'VerificationCompleted')
          }
        }
        const beforeReview = await fingerprintWorkspace(attempt.worktree.path)
        const diff = await captureGitDiff(attempt.worktree.path, taskStartCommit)
        const scope = graph.tasks.find(t => t.id === attempt.taskId)!.scope.allowedPaths
        const scopeDecision = checkScope(diff.files.map(f => f.path), scope)
        if (scopeDecision.outcome === 'deny') throw new Error(`POLICY VIOLATION: ${scopeDecision.reason}`)
        const diffEnvelope: WorkflowEvent = { kind: 'diff_captured', stage: 'implement', diff }
        this.ports.emit(id, attempt.taskId, attempt.id, diffEnvelope)
        attempt.events.push(diffEnvelope)
        await this.ports.record?.(id, attempt.id, diffEnvelope)
        if (attempt.verification.some(v => !v.success)) {
          attempt.reviewPending = false
          if (cycle === 1) throw new Error(`Prüfungen oder Reviews weiterhin fehlgeschlagen.\n${correctionEvidence(attempt.verification, [])}`)
          await this.agent(id, attempt, attempt.implementerId, 'fix', `${prompt}\nBehebe zuerst die fehlgeschlagenen automatischen Prüfungen:\n${correctionEvidence(attempt.verification, [])}`, false, signal)
          continue
        }
        attempt.reviewPending = true
        await this.save(id, 'ReviewStarted')
        // Reviewer and challenger are both readonly and independently judge
        // the same already-captured diff/verification - neither depends on
        // the other's output. Running them concurrently instead of one
        // after another roughly halves this phase's wall-clock time, which
        // live-observed dominates a task's total runtime. Trade-off: an
        // escalating reviewer no longer skips the other reviewer's call
        // (that early-exit only worked in the old sequential loop) - both
        // always run now, checked together below.
        const reviewerIds = [attempt.reviewerId, attempt.challengerId].filter((r): r is string => !!r)
        // Never cache by task id or diff alone: unchanged lines, requirements,
        // dependencies, prior findings and verification evidence also matter.
        // Elapsed test time is measurement noise, not verification evidence.
        const reviewKey = createHash('sha256').update(JSON.stringify({
          version: 1, contract: REVIEW_CONTRACT, workspace: beforeReview,
          spec: this.ports.spec(id, graph.specVersion), prompt, diff,
          checks: attempt.verification.map(({ durationMs: _durationMs, ...check }) => check),
          previousReviews: attempt.reviews, reviewerIds
        })).digest('hex')
        if (attempt.reviewCheckpoint?.key !== reviewKey) attempt.reviewCheckpoint = { key: reviewKey, results: {} }
        const reviewCheckpoint = attempt.reviewCheckpoint
        const reviewController = new AbortController()
        const reviewSignal = AbortSignal.any([signal, reviewController.signal])
        let firstFailure: unknown
        const results = await Promise.allSettled(reviewerIds.map(async reviewerId => {
          try {
            const saved = Object.prototype.hasOwnProperty.call(reviewCheckpoint.results, reviewerId) ? reviewCheckpoint.results[reviewerId] : undefined
            if (saved) {
              const envelope: WorkflowEvent = { kind: 'executor_event', stage: 'finalReview', event: {
                type: 'status', message: `Abgeschlossenes Review von ${reviewerId} bei unveränderter Prüfgrundlage fortgesetzt.`
              } }
              attempt.events.push(envelope)
              await this.ports.record?.(id, attempt.id, envelope)
              this.ports.emit(id, attempt.taskId, attempt.id, envelope)
              return saved
            }
            const verdict = await this.runReview(id, attempt, reviewerId, prompt, diff, reviewSignal)
            if (!reviewSignal.aborted && beforeReview === await fingerprintWorkspace(attempt.worktree!.path)) {
              reviewCheckpoint.results[reviewerId] = verdict
              await this.save(id, 'IndividualReviewCompleted')
            }
            return verdict
          }
          catch (err) { if (firstFailure === undefined) firstFailure = err; reviewController.abort(); throw err }
        }))
        if (firstFailure !== undefined) throw firstFailure
        attempt.reviews = results.map(result => {
          if (result.status === 'rejected') throw result.reason
          return result.value
        })
        attempt.reviewPending = false
        attempt.reviewCheckpoint = undefined
        if (attempt.reviews.some(r => r.verdict === 'escalate')) { attempt.status = 'escalated'; throw new Error('Architektur-Eskalation: Spezifikationsänderung erforderlich.') }
        if (attempt.verification.length === state.commands.length && attempt.verification.every(v => v.success) && attempt.reviews.every(r => r.verdict === 'pass')) {
          if (beforeReview !== await fingerprintWorkspace(attempt.worktree.path)) throw new Error('Prüfstand während Review verändert.')
          attempt.fingerprint = beforeReview; attempt.status = 'review'
          break
        }
        if (cycle === 1) {
          const findings = attempt.reviews.flatMap(r => r.verdict === 'pass' ? [] : r.findings.map(f => `${f.file ? `${f.file}: ` : ''}${f.message}`))
          const failedChecks = attempt.verification.filter(v => !v.success).map(v => `${v.command.executable} ${v.command.args.join(' ')}: ${v.stderr || v.stdout || `Exit ${v.exitCode}`}`)
          throw new Error(`Prüfungen oder Reviews weiterhin fehlgeschlagen.\n${[...findings, ...failedChecks].join('\n')}`)
        }
        await this.agent(id, attempt, attempt.implementerId, 'fix', `${prompt}\nBehebe diese nachgewiesenen Probleme:\n${correctionEvidence(attempt.verification, attempt.reviews)}`, false, signal)
      }
      if (signal.aborted) throw new Error('Abgebrochen.')
      this.approved(id)
      accountTime()
      runtime.stage = 'ready'
      attempt.finishedAt = Date.now()
      await this.save(id, 'TaskReadyForAcceptance')
      this.ports.emit(id, attempt.taskId, attempt.id, { kind: 'workflow_done', success: true })
    } catch (err) {
      accountTime()
      this.controllers.get(id)?.abort()
      const cause = persistenceError ?? (budgetExceeded ? new TaskControlError('budget', 'Laufzeitbudget erreicht. Arbeitsstand erhalten; Budget anpassen und fortsetzen.') : err)
      runtime.failureKind = classifyTaskFailure(cause)
      if (!['authentication', 'quota', 'process', 'budget', 'cancelled'].includes(runtime.failureKind)) attempt.reviewCheckpoint = undefined
      runtime.retryable = ['authentication', 'quota', 'process', 'budget', 'cancelled'].includes(runtime.failureKind)
      attempt.status = attempt.status === 'escalated' ? 'escalated' : runtime.retryable ? 'paused' : 'failed'
      attempt.finishedAt = Date.now(); attempt.error = cause instanceof Error ? cause.message : String(cause)
      if (attempt.error.startsWith('POLICY VIOLATION:')) attempt.reviewPending = false
      state.phase = 'halted'; state.haltReason = attempt.error
      await this.save(id, 'TaskFailed')
      this.ports.emit(id, attempt.taskId, attempt.id, { kind: 'workflow_done', success: false, reason: attempt.error })
      if (attempt.status === 'escalated') {
        await this.openChangeRequestForEscalation(id, attempt).catch(err => console.error('ChangeRequest konnte nicht angelegt werden:', err))
      }
    } finally {
      clearInterval(timer)
      if (checkpoint) await checkpoint
    }
  }
  /** 'escalated' is terminal in TaskGraph's own transition table - a human must decide via a ChangeRequest, there is no automatic retry. */
  private async openChangeRequestForEscalation(id: string, attempt: TaskAttempt): Promise<void> {
    const graph = this.graph(id)
    const task = graph.tasks.find(t => t.id === attempt.taskId)
    if (!task) return
    const escalation = attempt.reviews.find(r => r.verdict === 'escalate')
    const reason = escalation
      ? [escalation.reason, ...escalation.findings.map(f => `[${f.severity}] ${f.message}`)].filter(Boolean).join('\n')
      : (attempt.error ?? 'Architektur-Eskalation.')
    await this.ports.openChangeRequest(id, {
      projectId: id,
      affectedTaskIds: [task.id],
      affectedRequirementIds: task.requirementIds,
      reason,
      proposedChanges: '',
      severity: 'architecture'
    })
  }
  async accept(id: string, taskId: string): Promise<void> {
    await this.cancellable(id, async signal => {
      this.approved(id)
      const state = this.state(id), graph = this.graph(id)
      const attempt = [...state.attempts].reverse().find(a => a.taskId === taskId)
      requireVerifiedAttempt(attempt)
      if (attempt.fingerprint !== await fingerprintWorkspace(attempt.worktree!.path)) throw new Error('Dateien seit der Prüfung verändert. Erneute Prüfung erforderlich.')
      const integration = state.integration!
      // Keep the task branch/worktree until integration verification succeeds.
      await gitOutput(attempt.worktree!.path, ['add', '-A'])
      if ((await gitOutput(attempt.worktree!.path, ['diff', '--cached', '--name-only'])).trim()) {
        await gitOutput(attempt.worktree!.path, ['-c', 'commit.gpgsign=false', 'commit', '-m', `AI Council task ${taskId} attempt ${attempt.id}`])
      }
      attempt.commit = (await gitOutput(attempt.worktree!.path, ['rev-parse', 'HEAD'])).trim()
      // Commit changes HEAD, so store the new fingerprint for a safe retry.
      attempt.fingerprint = await fingerprintWorkspace(attempt.worktree!.path)
      // Test the merge on a separate branch. A failure must never contaminate
      // the integration base used by subsequent attempts or dependent tasks.
      let candidate: Awaited<ReturnType<typeof createWorktree>> | undefined
      try {
        await this.save(id, 'TaskIntegrationStarted')
        if (signal.aborted) throw new Error('Abgebrochen.')
        candidate = await createWorktree(integration.path, this.ports.worktreesRoot)
        candidate.sourceRepo = integration.sourceRepo
        attempt.integrationWorktrees = [...(attempt.integrationWorktrees ?? []), candidate]
        await this.save(id, 'IntegrationCandidateCreated')
        await gitOutput(candidate.path, ['merge', '--no-edit', attempt.worktree!.branch])
        const candidateHead = (await gitOutput(candidate.path, ['rev-parse', 'HEAD'])).trim()
        state.finalVerification = await this.checks(id, candidate.path, signal)
        if (signal.aborted) throw new Error('Abgebrochen.')
        if (state.finalVerification.length !== state.commands.length || state.finalVerification.some(v => !v.success)) throw new Error('Integrationsprüfung fehlgeschlagen. Erneut prüfen oder Versuch verwerfen und korrigieren.')
        if (candidateHead !== (await gitOutput(candidate.path, ['rev-parse', 'HEAD'])).trim() || (await gitOutput(candidate.path, ['status', '--porcelain'])).trim()) throw new Error('Integrationsprüfung hat den geprüften Stand verändert.')
        const previousIntegration = integration
        const taskWorktree = attempt.worktree
        state.integration = candidate
        // Task worktrees are created from the previous integration path, so
        // discard them first while that directory still exists. Use the
        // original source repo as cwd so git bookkeeping stays reachable.
        if (taskWorktree) {
          try {
            await discardWorktree({ ...taskWorktree, sourceRepo: previousIntegration.sourceRepo })
          } catch { /* merged into candidate */ }
          attempt.worktree = undefined
        }
        if (previousIntegration.path !== candidate.path) {
          try { await discardWorktree(previousIntegration) } catch { /* previous integration no longer needed */ }
        }
      } catch (err) {
        attempt.commit = undefined
        state.phase = 'halted'; state.haltReason = err instanceof Error ? err.message : String(err)
        // The failed integration-candidate worktree/branch is never used
        // again (integrationWorktrees is write-only, kept only as history)
        // and each retry of accept() creates a brand new one - without this,
        // every failed retry leaks another worktree/branch on disk forever.
        if (candidate) { try { await discardWorktree(candidate) } catch { /* best-effort cleanup */ } }
        await this.save(id, 'IntegrationVerificationFailed')
        throw err
      }
      attempt.status = 'accepted'
      // Projection happens in the persistence adapter alongside the event.
      const task = graph.tasks.find(t => t.id === taskId)!
      task.status = 'accepted'
      state.haltReason = undefined
      state.phase = graph.tasks.every(t => t.status === 'accepted') ? 'integration_review' : 'execution'
      await this.ports.save(state, graph, 'TaskAccepted')
    })
  }
  async discard(id: string, taskId: string): Promise<void> {
    await this.exclusive(id, async () => {
      const attempt = [...this.state(id).attempts].reverse().find(a => a.taskId === taskId)
      if (!attempt || attempt.status === 'accepted' || attempt.status === 'running' || attempt.status === 'awaiting_permission') throw new Error('Versuch kann nicht verworfen werden.')
      if (attempt.commit) throw new Error('Task wurde bereits zur Integration hinzugefügt. Erst Integrationsprüfung abschließen; stilles Entfernen würde Folge-Tasks gefährden.')
      // Interrupted agents might still own their worktree; preserve it for manual recovery.
      if (attempt.worktree && attempt.status !== 'interrupted' && !attempt.commit) await discardWorktree(attempt.worktree)
      attempt.status = 'discarded'
      await this.save(id, 'TaskDiscarded')
    })
  }
  async finalReview(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.approved(id)
      const state = this.state(id), graph = this.graph(id)
      if (state.phase === 'done') throw new Error('Dieser Projektlauf wurde bereits freigegeben.')
      // 'invalidated' tasks are correctly-superseded history from an applied
      // ChangeRequest (see replacedByTaskId) - requiring them to also be
      // 'accepted' would permanently block release after any ChangeRequest,
      // even once every real (replacement) task is done. Caught live.
      if (!state.integration || !graph.tasks.length || graph.tasks.some(t => t.status !== 'accepted' && t.status !== 'invalidated')) throw new Error('Zuerst alle Tasks integrieren.')
      const controller = new AbortController()
      this.controllers.set(id, controller)
      try {
        state.phase = 'integration_review'; state.releaseCommit = undefined
        const path = state.integration.path
        state.finalVerification = await this.checks(id, path, controller.signal)
        if (state.finalVerification.some(v => !v.success)) throw new Error('Gesamtprüfungen fehlgeschlagen.')
        if ((await gitOutput(path, ['status', '--porcelain'])).trim()) throw new Error('Integration enthält uncommittete Änderungen.')
        const commit = (await gitOutput(path, ['rev-parse', 'HEAD'])).trim()
        const prompt = `Finale Projektprüfung:\n${JSON.stringify(this.ports.spec(id, graph.specVersion))}\nTasks und Nachweise:\n${JSON.stringify(state.attempts.map(a => ({ taskId: a.taskId, status: a.status, commit: a.commit, reviews: a.reviews })))}\nTests:\n${JSON.stringify(state.finalVerification)}\nIntegrationsdiff:\n${await gitOutput(path, ['diff', state.sourceHead!, 'HEAD'])}${REVIEW_CONTRACT}`
        state.finalVerdict = parseReviewVerdict(await this.ports.council(prompt, controller.signal, graph.chairId, path, id, 'final_review'))
        if (state.finalVerdict.verdict !== 'pass' || controller.signal.aborted) throw new Error('Finales Council nicht erfolgreich.')
        if (commit !== (await gitOutput(path, ['rev-parse', 'HEAD'])).trim() || (await gitOutput(path, ['status', '--porcelain'])).trim()) throw new Error('Integrationsstand während Prüfung verändert.')
        state.releaseCommit = commit; state.phase = 'release_approval'
        await this.save(id, 'FinalCouncilPassed')
      } catch (err) { state.phase = 'halted'; state.haltReason = String(err); await this.save(id, 'FinalReviewFailed'); throw err }
      finally { this.controllers.delete(id) }
    })
  }
  async release(id: string, commit: string): Promise<void> {
    await this.exclusive(id, async () => {
      this.approved(id)
      const state = this.state(id)
      requireReleaseReady(state, this.graph(id))
      const integration = state.integration!
      if (commit !== state.releaseCommit || commit !== (await gitOutput(integration.path, ['rev-parse', 'HEAD'])).trim() ||
          (await gitOutput(integration.path, ['status', '--porcelain'])).trim()) throw new Error('Freigabe gehört nicht zum aktuellen Integrationsstand.')
      if ((await gitOutput(integration.sourceRepo, ['symbolic-ref', '--short', 'HEAD'])).trim() !== state.sourceBranch ||
          (await gitOutput(integration.sourceRepo, ['status', '--porcelain'])).trim()) throw new Error('Zielbranch gewechselt oder Arbeitsverzeichnis nicht sauber.')
      const targetHead = (await gitOutput(integration.sourceRepo, ['rev-parse', 'HEAD'])).trim()
      if (targetHead !== state.sourceHead && targetHead !== commit) throw new Error('Der Zielbranch wurde während der Entwicklung geändert. Neue Integration erforderlich.')
      // Fast-forward only: a changed target requires a new integration review, never a blind merge.
      await this.save(id, 'HumanReleaseApproved')
      await gitOutput(integration.sourceRepo, ['merge', '--ff-only', commit])
      state.phase = 'done'
      await this.save(id, 'ReleaseCompleted')
    })
  }
}
