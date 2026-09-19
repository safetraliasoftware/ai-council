import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CommandSpec, ProjectExecution, TaskAttempt, TaskGraphSnapshot } from '@ai-council/project-domain'
import { canResumeTaskCorrection, canRecheckReviewWorkspace } from '@ai-council/project-domain'
import { DEFAULT_TASK_BUDGET } from '@ai-council/project-domain'
import TaskProgress from './TaskProgress'
import TaskBudgetEditor from './TaskBudgetEditor'
import type { TaskStatus } from '@ai-council/task-graph'
import type { CodingExecutorId, RespondInstallRequestDto, WorktreeActionResult } from '../../../main/ipc-types'
import { CODING_EXECUTOR_LABELS } from '../../../main/ipc-types'
import ChangeRequests from './ChangeRequests'

const EXECUTORS: CodingExecutorId[] = ['claude-code-cli', 'openai-codex-cli', 'google-antigravity-cli', 'grok-build-cli']
const PHASE_KEYS: Record<ProjectExecution['phase'], string> = {
  planning: 'taskGraphExecution.phasePlanning', execution: 'taskGraphExecution.phaseExecution', integration_review: 'taskGraphExecution.phaseIntegrationReview',
  release_approval: 'taskGraphExecution.phaseReleaseApproval', done: 'taskGraphExecution.phaseDone', halted: 'taskGraphExecution.phaseHalted'
}
const STATUS_KEYS: Record<TaskAttempt['status'], string> = { running: 'taskGraphExecution.statusRunning', review: 'taskGraphExecution.statusReview', failed: 'taskGraphExecution.statusFailed',
  interrupted: 'taskGraphExecution.statusInterrupted', accepted: 'taskGraphExecution.statusAccepted', discarded: 'taskGraphExecution.statusDiscarded', escalated: 'taskGraphExecution.statusEscalated',
  awaiting_permission: 'taskGraphExecution.statusAwaitingPermission', awaiting_install: 'taskGraphExecution.statusAwaitingInstall', paused: 'taskGraphExecution.statusPaused' }
// Task-level statuses (not attempt-level) reachable only via the
// ChangeRequest flow - see applyChangeRequest() in project-engine.ts.
const TASK_ONLY_STATUS_KEYS: Partial<Record<TaskStatus, string>> = {
  invalidated: 'taskGraphExecution.taskStatusInvalidated',
  needs_revalidation: 'taskGraphExecution.taskStatusNeedsRevalidation'
}
export default function TaskGraphExecution({ projectId, taskGraph, onChanged, onRequestSpecRevision }: {
  projectId: string; taskGraph: TaskGraphSnapshot; onChanged: () => void | Promise<void>
  onRequestSpecRevision: (note: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<ProjectExecution>()
  const [directory, setDirectory] = useState(taskGraph.workingDirectory ?? '')
  const [commands, setCommands] = useState<CommandSpec[]>(taskGraph.suggestedCommands ?? [])
  const [attemptLimit, setAttemptLimit] = useState(3)
  const [budget, setBudget] = useState({ ...DEFAULT_TASK_BUDGET })
  const [implementerId, setImplementer] = useState<CodingExecutorId>('claude-code-cli')
  const [reviewerId, setReviewer] = useState<CodingExecutorId>('openai-codex-cli')
  const [challengerId, setChallenger] = useState<CodingExecutorId | ''>('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>()
  // Jumps straight to a specific attempt's Agent-Protokoll (see the button
  // next to a failed attempt's error below) - the protocol already exists,
  // it's just nested two <details> deep and easy to miss right when a task
  // fails, which is exactly when someone actually wants to see it.
  const attemptRefs = useRef(new Map<string, HTMLDetailsElement>())
  const protocolRefs = useRef(new Map<string, HTMLDetailsElement>())
  // Which attempts' Agent-Protokoll is actually expanded - JSON.stringify of
  // attempt.events (every streamed chunk from every agent turn) is only
  // computed for those. Without this, every attempt of every task got
  // re-stringified on every 1.5s poll regardless of whether its <details>
  // was even open, which after enough real attempts pinned the renderer at
  // ~100% CPU continuously - caught live via Task Manager, not a guess.
  const [openProtocols, setOpenProtocols] = useState<Set<string>>(new Set())
  // Fetched on demand only for attempts whose protocol is actually open -
  // the summary poll below never carries attempt.events at all anymore.
  const [attemptEvents, setAttemptEvents] = useState<Map<string, unknown[]>>(new Map())
  const showProtocol = (attemptId: string): void => {
    const attemptEl = attemptRefs.current.get(attemptId)
    const protocolEl = protocolRefs.current.get(attemptId)
    if (attemptEl) attemptEl.open = true
    if (protocolEl) protocolEl.open = true
    ;(protocolEl ?? attemptEl)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  useEffect(() => {
    window.api.settings.getWorkspaceRoot().then(setWorkspaceRoot)
  }, [])
  useEffect(() => {
    let disposed = false, loading = false, first = true
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const next = await window.api.taskGraph.executionSummary(projectId)
        if (disposed) return
        setState(next)
        // No execution row yet (project not configured/started) - next is
        // undefined until engine.configure() runs. Leave commands/budget at
        // their taskGraph-derived defaults instead of dereferencing next.
        if (next) {
          if (first) setBudget(next.budget ?? { ...DEFAULT_TASK_BUDGET })
          if (first && next.commands.length) { setCommands(next.commands); setAttemptLimit(next.maxAttempts) }
        }
        first = false
      } catch (err) { if (!disposed) setError(String(err)) }
      finally { loading = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    return () => { disposed = true; clearInterval(timer) }
  }, [projectId])

  const act = async (action: () => Promise<WorktreeActionResult | void>) => {
    setBusy(true); setError('')
    try {
      const result = await action()
      if (result && !result.ok) throw new Error(result.error)
      setState(await window.api.taskGraph.executionSummary(projectId))
      await onChanged()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const running = state?.attempts.some(a => a.status === 'running' || a.status === 'awaiting_permission' || a.status === 'awaiting_install')
  const roles = [
    { label: t('taskGraphExecution.roleImplementer'), isChallenger: false, value: implementerId, change: (v: string) => setImplementer(v as CodingExecutorId) },
    { label: t('taskGraphExecution.roleReviewer'), isChallenger: false, value: reviewerId, change: (v: string) => setReviewer(v as CodingExecutorId) },
    { label: t('taskGraphExecution.roleChallenger'), isChallenger: true, value: challengerId, change: (v: string) => setChallenger(v as CodingExecutorId | '') }
  ]
  return <section style={{ marginTop: 16 }}>
    <p><strong>{t('taskGraphExecution.projectRunLine', { phase: state ? t(PHASE_KEYS[state.phase]) : t('taskGraphExecution.loadingPhase') })}</strong></p>
    {state && <p className="status-neutral">{t('taskGraphExecution.runSpecLine', { runId: state.runId, version: state.specVersion })}</p>}
    {error && <p className="error-text">{error}</p>}
    {(busy || running || state?.phase === 'execution' || state?.phase === 'integration_review') && <button onClick={() => void window.api.taskGraph.abortTask(projectId, '').catch(err => setError(String(err)))}>{t('taskGraphExecution.haltProjectRun')}</button>}
    {state?.haltReason && <p className="error-text">{state.haltReason}</p>}
    {state && (!taskGraph.workingDirectory || !state.commands.length) && <div role="status" className="status-neutral">
      <strong>{t('taskGraphExecution.beforeFirstStartHeading')}</strong>
      <ul>
        {!taskGraph.workingDirectory && <li>{t('taskGraphExecution.missingWorkingDir')}</li>}
        {!state.commands.length && <li>{t('taskGraphExecution.missingCommands')}</li>}
      </ul>
      <p>{t('taskGraphExecution.afterSetupHint')}</p>
    </div>}
    {state && state.specVersion !== taskGraph.specVersion && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.adoptPlan(projectId))}>{t('taskGraphExecution.adoptPlanButton', { version: taskGraph.specVersion })}</button>}
    {!!state?.archivedAttempts?.length && <details><summary>{t('taskGraphExecution.archivedAttemptsSummary', { count: state.archivedAttempts.length })}</summary><pre>{JSON.stringify(state.archivedAttempts, null, 2)}</pre></details>}
    {!taskGraph.workingDirectory && <div className="field">
      <label>{t('taskGraphExecution.workingDirLabel')}</label><input value={directory} onChange={e => setDirectory(e.target.value)} />
      <p>{t('taskGraphExecution.workingDirHint')}</p>
      {workspaceRoot && <p className="status-neutral">
        {t('taskGraphExecution.workspaceRootHint', { path: workspaceRoot })}
      </p>}
      <button onClick={() => void act(async () => { const path = await window.api.coding.pickDirectory(); if (path) setDirectory(path) })}>{t('taskGraphExecution.browse')}</button>
      {workspaceRoot && <button onClick={() => setDirectory(`${workspaceRoot}\\`)}>{t('taskGraphExecution.createInWorkspaceRoot')}</button>}
      <button disabled={busy || !directory.trim()} onClick={() => void act(() => window.api.taskGraph.setWorkingDirectory({ projectId, workingDirectory: directory }))}>{t('taskGraphExecution.setupWorkingDir')}</button>
    </div>}
    <details open={!state?.commands.length}>
      <summary>{t('taskGraphExecution.mandatoryChecksHeading')}</summary>
      <p>{t('taskGraphExecution.mandatoryChecksIntro')}</p>
      {!state?.commands.length && (
        taskGraph.suggestedCommands?.length
          ? <p className="status-neutral">{t('taskGraphExecution.suggestedCommandsHint')}</p>
          : <p className="status-neutral">{t('taskGraphExecution.noStackDetectedHint')}</p>
      )}
      {commands.map((command, i) => <div className="row" key={i}>
        <input aria-label={t('taskGraphExecution.ariaProgram')} value={command.executable} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, executable: e.target.value } : c))} />
        <input aria-label={t('taskGraphExecution.ariaArgs')} value={command.args.join(' ')} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, args: e.target.value.split(' ') } : c))} />
        <input aria-label={t('taskGraphExecution.timeoutSecondsLabel')} type="number" value={command.timeoutMs / 1000} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, timeoutMs: Number(e.target.value) * 1000 } : c))} />
        <button onClick={() => setCommands(prev => prev.filter((_, n) => n !== i))}>{t('taskGraphExecution.remove')}</button>
      </div>)}
      <button onClick={() => setCommands(prev => [...prev, { executable: '', args: [], timeoutMs: 300000 }])}>{t('taskGraphExecution.addCheck')}</button>
      <label>{t('taskGraphExecution.maxAttemptsLabel')} <input type="number" min={1} max={10} value={attemptLimit} onChange={e => setAttemptLimit(Number(e.target.value))} /></label>
      <label>{t('taskGraphExecution.maxCallsLabel')} <input type="number" min={1} max={100} value={budget.maxCalls} onChange={e => setBudget(b => ({ ...b, maxCalls: Number(e.target.value) }))} /></label>
      <label>{t('taskGraphExecution.maxActiveMinutesLabel')} <input type="number" min={1} max={240} value={budget.maxActiveMs / 60_000} onChange={e => setBudget(b => ({ ...b, maxActiveMs: Number(e.target.value) * 60_000 }))} /></label>
      <label>{t('taskGraphExecution.maxCorrectionsLabel')} <input type="number" min={0} max={20} value={budget.maxCorrections} onChange={e => setBudget(b => ({ ...b, maxCorrections: Number(e.target.value) }))} /></label>
      <p>{t('taskGraphExecution.budgetsHint')}</p>
      <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.configure(projectId, commands.map(c => ({ ...c, args: c.args.filter(Boolean) })), attemptLimit, budget))}>{t('taskGraphExecution.saveProfileAndBudgets')}</button>
    </details>
    <div className="row">{roles.map(role => <label key={role.label}>{role.label}<select value={role.value} onChange={e => role.change(e.target.value)}>
      {role.isChallenger && <option value="">{t('taskGraphExecution.noAdditionalChallenger')}</option>}
      {EXECUTORS.map(id => <option key={id} value={id}>{CODING_EXECUTOR_LABELS[id]}</option>)}
    </select></label>)}</div>
    {taskGraph.tasks.map(task => {
      const attempts = state?.attempts.filter(a => a.taskId === task.id) ?? []
      const latest = attempts.at(-1)
      const taskBudget = state?.taskBudgets?.[task.id] ?? state?.budget ?? DEFAULT_TASK_BUDGET
      const usedMs = attempts.filter(a => a.specVersion === taskGraph.specVersion).reduce((sum, a) => sum + (a.runtime?.activeMs ?? 0), 0)
      const resumeCorrection = canResumeTaskCorrection(latest, taskGraph.specVersion)
      const recheckWorkspace = canRecheckReviewWorkspace(latest, taskGraph.specVersion)
      const acceptedIds = new Set(state?.attempts.filter(a => a.status === 'accepted').map(a => a.taskId))
      const ready = task.dependencies.every(d => acceptedIds.has(d.taskId) || taskGraph.tasks.find(t => t.id === d.taskId)?.status === 'accepted')
      return <div key={task.id} className="result-card" style={{ marginTop: 12 }}>
        <strong>{task.id}: {task.title}</strong><p>{task.description}</p>
        <p>{(latest ? t(STATUS_KEYS[latest.status]) : task.status === 'accepted' ? t('taskGraphExecution.acceptedLegacy') : (TASK_ONLY_STATUS_KEYS[task.status] ? t(TASK_ONLY_STATUS_KEYS[task.status]!) : t('taskGraphExecution.notStartedYet')))} · {t('taskGraphExecution.attemptsCount', { count: attempts.length })}</p>
        <TaskProgress attempts={attempts.filter(a => a.specVersion === taskGraph.specVersion)} budget={taskBudget} />
        {state?.phase !== 'done' && task.status !== 'accepted' && task.status !== 'invalidated' &&
          <TaskBudgetEditor key={`${task.id}:${JSON.stringify(taskBudget)}`} taskId={task.id} budget={taskBudget} usedMs={usedMs}
            paused={latest?.status === 'paused'} disabled={busy || !!running}
            onSave={next => act(() => window.api.taskGraph.setTaskBudget(projectId, task.id, next))} />}
        {latest?.error && (
          <p className="error-text">
            {latest.error}{' '}
            {attempts.length > 0 && (
              <button className="link" onClick={() => showProtocol(latest.id)}>
                {t('taskGraphExecution.showProtocolLink')}
              </button>
            )}
          </p>
        )}
        {task.status === 'invalidated' && !!task.replacedByTaskId?.length && <p className="status-neutral">{t('taskGraphExecution.replacedBy', { ids: task.replacedByTaskId.join(', ') })}</p>}
        {latest?.status === 'escalated' && <p className="error-text">{t('taskGraphExecution.architectureDecisionNeeded')}</p>}
        <ChangeRequests projectId={projectId} taskId={task.id} onChanged={onChanged} onRequestSpecRevision={onRequestSpecRevision} />
        {state && latest?.status !== 'paused' && !resumeCorrection && !recheckWorkspace && !latest?.reviewPending && task.status !== 'accepted' && task.status !== 'invalidated' && attempts.length >= state.maxAttempts && (
          // The attempt-limit control otherwise only lives in the collapsed
          // "Verbindliche Build-/Testprüfungen" section far above - easy to
          // miss right when a task actually needs it. Raises the SAME
          // project-wide limit (there's no separate per-task limit), just
          // reachable directly from the task that hit it. Caught live.
          <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.configure(projectId, state.commands, state.maxAttempts + 1))}>
            {t('taskGraphExecution.increaseAttemptLimit', { limit: state.maxAttempts + 1 })}
          </button>
        )}
        {((!latest || ['failed', 'discarded', 'interrupted', 'paused'].includes(latest.status)) || task.status === 'needs_revalidation') && task.status !== 'accepted' && task.status !== 'invalidated' && <button disabled={busy || running || !ready || !state?.commands.length || !taskGraph.workingDirectory} onClick={() => void act(async () => {
          const result = await window.api.taskGraph.runTask({ projectId, taskId: task.id, implementerId, reviewerId, challengerId: challengerId || undefined, recheckWorkspace })
          if (!result.workflowId) throw new Error(result.error)
        })}>{task.status === 'needs_revalidation' ? t('taskGraphExecution.startRevalidation') : recheckWorkspace ? t('taskGraphExecution.recheckWorkspaceLabel') : latest?.status === 'paused' ? t('taskGraphExecution.resumeAfterPause') : resumeCorrection ? t('taskGraphExecution.continueCorrection') : latest?.status === 'failed' && latest.reviewPending ? t('taskGraphExecution.repeatReview') : latest ? t('taskGraphExecution.startNewAttempt') : t('taskGraphExecution.startTask')}</button>}
        {latest?.status === 'running' && <button onClick={() => void act(() => window.api.taskGraph.abortTask(projectId, task.id))}>{t('taskGraphExecution.cancel')}</button>}
        {latest?.status === 'awaiting_permission' && (
          <div className="result-card" style={{ marginTop: 8 }}>
            <p className="error-text">
              {t('taskGraphExecution.permissionActionsBlocked', { actions: latest.pendingPermissionActions?.join(', ') ?? '' })}
            </p>
            <p>{t('taskGraphExecution.grantFullPermissionsQuestion')}</p>
    <div className="row">
              <button disabled={busy} onClick={() => void act(() => window.api.taskGraph.respondPermission({ projectId, attemptId: latest.id, granted: false }))}>{t('taskGraphExecution.reject')}</button>
              <button className="primary" disabled={busy} onClick={() => void act(() => window.api.taskGraph.respondPermission({ projectId, attemptId: latest.id, granted: true }))}>{t('taskGraphExecution.grantFullPermissions')}</button>
            </div>
          </div>
        )}
        {latest?.status === 'awaiting_install' && latest.pendingInstallAction && (
          <InstallApproval key={latest.id} request={latest.pendingInstallAction} busy={busy}
            onDecision={decision => act(() => window.api.taskGraph.respondInstall({ projectId, attemptId: latest.id, decision }))} />
        )}
        {latest?.status === 'review' && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.acceptTask({ projectId, taskId: task.id }))}>{t('taskGraphExecution.integrateReviewedTask')}</button>}
        {/*
          'escalated' included here too: discard() has always allowed it
          (only 'accepted'/'running'/'awaiting_permission' are actually
          blocked) - this button just never surfaced that. 'escalated' has
          no automatic way out otherwise (TaskGraph's own transition table:
          escalated -> []), so without this the only path was rejecting the
          associated ChangeRequest (which now also discards it - see
          change-request-ipc.ts) - useless once that CR was already
          rejected before that fix existed, or if there never was one.
          Caught live: a task stayed stuck at "Architekturentscheidung
          erforderlich" with no visible way forward at all.
        */}
        {latest && ['review', 'failed', 'interrupted', 'escalated', 'paused'].includes(latest.status) && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.discardTask({ projectId, taskId: task.id }))}>{t('taskGraphExecution.discardAttempt')}</button>}
        {attempts.map(attempt => <details key={attempt.id} ref={el => { if (el) attemptRefs.current.set(attempt.id, el) }}><summary>{t('taskGraphExecution.attemptSummary', { id: attempt.id.slice(0, 8), status: t(STATUS_KEYS[attempt.status]) })}</summary>
          <p>{attempt.implementerId} → {attempt.reviewerId}{attempt.challengerId ? ` → ${attempt.challengerId}` : ''}</p>
          {attempt.verification.map((v, i) => <details key={i}><summary>{v.success ? '✓' : '✕'} {v.command.executable} {v.command.args.join(' ')} · {t('taskGraphExecution.exitLabel', { code: v.exitCode ?? '–' })} · {v.durationMs} ms</summary><pre>{v.stdout}{v.stderr}</pre></details>)}
          {attempt.reviews.map((r, i) => <pre key={i}>{JSON.stringify(r, null, 2)}</pre>)}
          <details ref={el => { if (el) protocolRefs.current.set(attempt.id, el) }}
            onToggle={e => {
              const open = e.currentTarget.open
              setOpenProtocols(prev => {
                if (open === prev.has(attempt.id)) return prev
                const next = new Set(prev)
                if (open) next.add(attempt.id); else next.delete(attempt.id)
                return next
              })
              if (open && !attemptEvents.has(attempt.id)) {
                void window.api.taskGraph.attemptEvents({ projectId, attemptId: attempt.id })
                  .then(events => setAttemptEvents(prev => new Map(prev).set(attempt.id, events)))
                  .catch(err => setError(err instanceof Error ? err.message : String(err)))
              }
            }}>
            <summary>{t('taskGraphExecution.agentProtocol')}</summary>
            {openProtocols.has(attempt.id) && <pre style={{ maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(attemptEvents.get(attempt.id) ?? [], null, 2)}</pre>}
          </details>
        </details>)}
      </div>
    })}
    <div className="row" style={{ marginTop: 16 }}>
      <button disabled={busy || running || !state?.commands.length || state.phase === 'done'} onClick={() => void act(() => window.api.taskGraph.runReadyTasks({ projectId, taskId: '', implementerId, reviewerId, challengerId: challengerId || undefined }))}>{t('taskGraphExecution.runReadyTasksButton')}</button>
      <button disabled={busy || running || state?.phase === 'done'} onClick={() => void act(() => window.api.taskGraph.finalReview(projectId))}>{t('taskGraphExecution.startFinalReview')}</button>
      {state?.phase === 'release_approval' && <button className="primary" disabled={busy} onClick={() => void act(() => window.api.taskGraph.release(projectId, state.releaseCommit!))}>{t('taskGraphExecution.releaseButton', { commit: state.releaseCommit?.slice(0, 12) })}</button>}
    </div>
    {state?.finalVerification?.map((v, i) => <details key={i}><summary>{t('taskGraphExecution.integrationCheckLabel')} {v.command.executable} {v.command.args.join(' ')} {v.success ? '✓' : '✕'}</summary><pre>{v.stdout}{v.stderr}</pre></details>)}
    {state?.finalVerdict && <pre>{JSON.stringify(state.finalVerdict, null, 2)}</pre>}
  </section>
}

function InstallApproval({ request, busy, onDecision }: {
  request: NonNullable<TaskAttempt['pendingInstallAction']>
  busy: boolean
  onDecision: (decision: RespondInstallRequestDto['decision']) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [command, setCommand] = useState<CommandSpec>(() => structuredClone(request.suggestedCommand ?? {
    executable: '', args: [], timeoutMs: 600000
  }))
  const valid = !!command.executable.trim() && Number.isFinite(command.timeoutMs) && command.timeoutMs >= 100 && command.timeoutMs <= 3600000
  return <div className="result-card" style={{ marginTop: 8 }}>
    <p>{t('taskGraphExecution.toolNotFound', { executable: request.executable })}</p>
    <p>{request.suggestedCommand ? t('taskGraphExecution.reviewSuggestedCommand') : t('taskGraphExecution.noInstallCommandKnown')}</p>
    <label>{t('taskGraphExecution.installProgramLabel')} <input disabled={busy} value={command.executable} onChange={e => setCommand({ ...command, executable: e.target.value })} /></label>
    {command.args.map((arg, index) => <div className="row" key={index}>
      <label>{t('taskGraphExecution.argumentLabel', { index: index + 1 })} <input disabled={busy} value={arg} onChange={e => setCommand({ ...command, args: command.args.map((a, i) => i === index ? e.target.value : a) })} /></label>
      <button disabled={busy} onClick={() => setCommand({ ...command, args: command.args.filter((_, i) => i !== index) })}>{t('taskGraphExecution.removeArgument')}</button>
    </div>)}
    <button disabled={busy} onClick={() => setCommand({ ...command, args: [...command.args, ''] })}>{t('taskGraphExecution.addArgument')}</button>
    <label>{t('taskGraphExecution.timeoutSecondsLabel')} <input disabled={busy} type="number" min={1} max={3600} value={command.timeoutMs / 1000} onChange={e => setCommand({ ...command, timeoutMs: Number(e.target.value) * 1000 })} /></label>
    <div className="row">
      <button disabled={busy} onClick={() => void onDecision({ approved: false })}>{t('taskGraphExecution.rejectInstall')}</button>
      <button className="primary" disabled={busy || !valid} onClick={() => void onDecision({ approved: true, command: { ...command, executable: command.executable.trim() } })}>{t('taskGraphExecution.installAndRetry')}</button>
    </div>
  </div>
}
