import { useEffect, useRef, useState } from 'react'
import type { CommandSpec, ProjectExecution, TaskAttempt, TaskGraphSnapshot } from '@ai-council/project-domain'
import { canResumeTaskCorrection, canRecheckReviewWorkspace } from '@ai-council/project-domain'
import { DEFAULT_TASK_BUDGET } from '@ai-council/project-domain'
import TaskProgress from './TaskProgress'
import TaskBudgetEditor from './TaskBudgetEditor'
import type { TaskStatus } from '@ai-council/task-graph'
import type { CodingExecutorId, RespondInstallRequestDto, WorktreeActionResult } from '../../../main/ipc-types'
import { CODING_EXECUTOR_LABELS } from '../../../main/ipc-types'
import ChangeRequests from './ChangeRequests'

const EXECUTORS: CodingExecutorId[] = ['claude-code-cli', 'openai-codex-cli', 'google-antigravity-cli']
const PHASES: Record<ProjectExecution['phase'], string> = {
  planning: 'Einrichtung', execution: 'Ausführung', integration_review: 'Gesamtprüfung',
  release_approval: 'Wartet auf Release-Freigabe', done: 'Freigegeben', halted: 'Angehalten'
}
const STATUSES: Record<TaskAttempt['status'], string> = { running: 'Läuft', review: 'Geprüft – bereit zur Integration', failed: 'Fehlgeschlagen',
  interrupted: 'Unterbrochen', accepted: 'Integriert', discarded: 'Verworfen', escalated: 'Architekturentscheidung erforderlich',
  awaiting_permission: 'Erweiterte Rechte angefragt', awaiting_install: 'Wartet auf Installationsentscheidung', paused: 'Pausiert – Arbeitsstand erhalten' }
// Task-level statuses (not attempt-level) reachable only via the
// ChangeRequest flow - see applyChangeRequest() in project-engine.ts.
const TASK_ONLY_STATUSES: Partial<Record<TaskStatus, string>> = {
  invalidated: 'Ungültig (durch Änderungsanfrage ersetzt)',
  needs_revalidation: 'Erneute Prüfung nötig'
}
export default function TaskGraphExecution({ projectId, taskGraph, onChanged, onRequestSpecRevision }: {
  projectId: string; taskGraph: TaskGraphSnapshot; onChanged: () => void | Promise<void>
  onRequestSpecRevision: (note: string) => void
}): React.JSX.Element {
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
    { label: 'Implementer', value: implementerId, change: (v: string) => setImplementer(v as CodingExecutorId) },
    { label: 'Reviewer', value: reviewerId, change: (v: string) => setReviewer(v as CodingExecutorId) },
    { label: 'Challenger', value: challengerId, change: (v: string) => setChallenger(v as CodingExecutorId | '') }
  ]
  return <section style={{ marginTop: 16 }}>
    <p><strong>Projektlauf: {state ? PHASES[state.phase] : 'Wird geladen…'}</strong></p>
    {state && <p className="status-neutral">Run {state.runId} · Spec v{state.specVersion}</p>}
    {error && <p className="error-text">{error}</p>}
    {(busy || running || state?.phase === 'execution' || state?.phase === 'integration_review') && <button onClick={() => void window.api.taskGraph.abortTask(projectId, '').catch(err => setError(String(err)))}>Projektlauf anhalten</button>}
    {state?.haltReason && <p className="error-text">{state.haltReason}</p>}
    {state && (!taskGraph.workingDirectory || !state.commands.length) && <div role="status" className="status-neutral">
      <strong>Vor dem ersten Start fehlt noch:</strong>
      <ul>
        {!taskGraph.workingDirectory && <li>Projektordner unten auswählen und „Projektordner einrichten“ anklicken.</li>}
        {!state.commands.length && <li>Unter „Verbindliche Build-/Testprüfungen“ passende Befehle eintragen und „Prüfprofil und Budgets speichern“ anklicken.</li>}
      </ul>
      <p>Danach lässt sich der erste Task starten. Weitere Tasks warten auf die Integration ihrer Vorgänger.</p>
    </div>}
    {state && state.specVersion !== taskGraph.specVersion && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.adoptPlan(projectId))}>Genehmigten Plan v{taskGraph.specVersion} übernehmen; bisherige Versuche archivieren</button>}
    {!!state?.archivedAttempts?.length && <details><summary>Archivierte Versuche aus vorherigen Spec-Versionen ({state.archivedAttempts.length})</summary><pre>{JSON.stringify(state.archivedAttempts, null, 2)}</pre></details>}
    {!taskGraph.workingDirectory && <div className="field">
      <label>Projektordner</label><input value={directory} onChange={e => setDirectory(e.target.value)} />
      <p>Leere Ordner werden eingerichtet. Vorhandene Git-Projekte bleiben bis zur Release-Freigabe unverändert.</p>
      {workspaceRoot && <p className="status-neutral">
        Werkstatt-Ordner (aus den Einstellungen): {workspaceRoot} – lege dieses Projekt als eigenen Unterordner darin an.
      </p>}
      <button onClick={() => void act(async () => { const path = await window.api.coding.pickDirectory(); if (path) setDirectory(path) })}>Durchsuchen</button>
      {workspaceRoot && <button onClick={() => setDirectory(`${workspaceRoot}\\`)}>Im Werkstatt-Ordner anlegen</button>}
      <button disabled={busy || !directory.trim()} onClick={() => void act(() => window.api.taskGraph.setWorkingDirectory({ projectId, workingDirectory: directory }))}>Projektordner einrichten</button>
    </div>}
    <details open={!state?.commands.length}>
      <summary>Verbindliche Build-/Testprüfungen</summary>
      <p>Diese Befehle werden direkt im isolierten Projekt ausgeführt. Prüfe sie für dein Projekt und gib das Prüfprofil frei.</p>
      {!state?.commands.length && (
        taskGraph.suggestedCommands?.length
          ? <p className="status-neutral">Vorschlag automatisch anhand des erkannten Projekt-Stacks - bitte prüfen und bei Bedarf anpassen.</p>
          : <p className="status-neutral">Kein Stack automatisch erkannt - bitte Test-/Build-Befehle manuell angeben.</p>
      )}
      {commands.map((command, i) => <div className="row" key={i}>
        <input aria-label="Programm" value={command.executable} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, executable: e.target.value } : c))} />
        <input aria-label="Argumente (durch Leerzeichen getrennt)" value={command.args.join(' ')} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, args: e.target.value.split(' ') } : c))} />
        <input aria-label="Timeout in Sekunden" type="number" value={command.timeoutMs / 1000} onChange={e => setCommands(prev => prev.map((c, n) => n === i ? { ...c, timeoutMs: Number(e.target.value) * 1000 } : c))} />
        <button onClick={() => setCommands(prev => prev.filter((_, n) => n !== i))}>Entfernen</button>
      </div>)}
      <button onClick={() => setCommands(prev => [...prev, { executable: '', args: [], timeoutMs: 300000 }])}>Prüfung hinzufügen</button>
      <label>Maximale Versuche je Task <input type="number" min={1} max={10} value={attemptLimit} onChange={e => setAttemptLimit(Number(e.target.value))} /></label>
      <label>Modellaufrufe je Task <input type="number" min={1} max={100} value={budget.maxCalls} onChange={e => setBudget(b => ({ ...b, maxCalls: Number(e.target.value) }))} /></label>
      <label>Aktive Minuten je Task <input type="number" min={1} max={240} value={budget.maxActiveMs / 60_000} onChange={e => setBudget(b => ({ ...b, maxActiveMs: Number(e.target.value) * 60_000 }))} /></label>
      <label>Korrekturen je Task <input type="number" min={0} max={20} value={budget.maxCorrections} onChange={e => setBudget(b => ({ ...b, maxCorrections: Number(e.target.value) }))} /></label>
      <p>Budgets gelten über Fortsetzungen hinweg. Bei Erreichen wird pausiert. Erhöhungen müssen hier bewusst gespeichert werden.</p>
      <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.configure(projectId, commands.map(c => ({ ...c, args: c.args.filter(Boolean) })), attemptLimit, budget))}>Prüfprofil und Budgets speichern</button>
    </details>
    <div className="row">{roles.map(role => <label key={role.label}>{role.label}<select value={role.value} onChange={e => role.change(e.target.value)}>
      {role.label === 'Challenger' && <option value="">Kein zusätzlicher Challenger</option>}
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
        <p>{latest ? STATUSES[latest.status] : task.status === 'accepted' ? 'Angenommen (Altbestand)' : TASK_ONLY_STATUSES[task.status] ?? 'Noch nicht gestartet'} · {attempts.length} Versuche</p>
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
                Ablaufprotokoll anzeigen
              </button>
            )}
          </p>
        )}
        {task.status === 'invalidated' && !!task.replacedByTaskId?.length && <p className="status-neutral">Ersetzt durch {task.replacedByTaskId.join(', ')}.</p>}
        {latest?.status === 'escalated' && <p className="error-text">Architekturentscheidung erforderlich – siehe unten.</p>}
        <ChangeRequests projectId={projectId} taskId={task.id} onChanged={onChanged} onRequestSpecRevision={onRequestSpecRevision} />
        {state && latest?.status !== 'paused' && !resumeCorrection && !recheckWorkspace && !latest?.reviewPending && task.status !== 'accepted' && task.status !== 'invalidated' && attempts.length >= state.maxAttempts && (
          // The attempt-limit control otherwise only lives in the collapsed
          // "Verbindliche Build-/Testprüfungen" section far above - easy to
          // miss right when a task actually needs it. Raises the SAME
          // project-wide limit (there's no separate per-task limit), just
          // reachable directly from the task that hit it. Caught live.
          <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.configure(projectId, state.commands, state.maxAttempts + 1))}>
            Versuchslimit auf {state.maxAttempts + 1} erhöhen
          </button>
        )}
        {((!latest || ['failed', 'discarded', 'interrupted', 'paused'].includes(latest.status)) || task.status === 'needs_revalidation') && task.status !== 'accepted' && task.status !== 'invalidated' && <button disabled={busy || running || !ready || !state?.commands.length || !taskGraph.workingDirectory} onClick={() => void act(async () => {
          const result = await window.api.taskGraph.runTask({ projectId, taskId: task.id, implementerId, reviewerId, challengerId: challengerId || undefined, recheckWorkspace })
          if (!result.workflowId) throw new Error(result.error)
        })}>{task.status === 'needs_revalidation' ? 'Revalidierung starten' : recheckWorkspace ? 'Arbeitsstand erneut prüfen' : latest?.status === 'paused' ? 'Nach Pause fortsetzen' : resumeCorrection ? 'Korrektur fortsetzen' : latest?.status === 'failed' && latest.reviewPending ? 'Review wiederholen' : latest ? 'Neuen Versuch starten' : 'Task starten'}</button>}
        {latest?.status === 'running' && <button onClick={() => void act(() => window.api.taskGraph.abortTask(projectId, task.id))}>Abbrechen</button>}
        {latest?.status === 'awaiting_permission' && (
          <div className="result-card" style={{ marginTop: 8 }}>
            <p className="error-text">
              Der Implementer wollte folgende Aktion(en) ausführen, die im aktuellen Rechte-Level nicht erlaubt sind: {latest.pendingPermissionActions?.join(', ')}
            </p>
            <p>Für diesen Versuch volle Rechte (inkl. Shell-Befehle) erteilen, damit er fortsetzen kann? Der Scope-Bereich (allowedPaths) bleibt danach trotzdem geprüft.</p>
    <div className="row">
              <button disabled={busy} onClick={() => void act(() => window.api.taskGraph.respondPermission({ projectId, attemptId: latest.id, granted: false }))}>Ablehnen</button>
              <button className="primary" disabled={busy} onClick={() => void act(() => window.api.taskGraph.respondPermission({ projectId, attemptId: latest.id, granted: true }))}>Volle Rechte erteilen</button>
            </div>
          </div>
        )}
        {latest?.status === 'awaiting_install' && latest.pendingInstallAction && (
          <InstallApproval key={latest.id} request={latest.pendingInstallAction} busy={busy}
            onDecision={decision => act(() => window.api.taskGraph.respondInstall({ projectId, attemptId: latest.id, decision }))} />
        )}
        {latest?.status === 'review' && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.acceptTask({ projectId, taskId: task.id }))}>Geprüften Task integrieren</button>}
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
        {latest && ['review', 'failed', 'interrupted', 'escalated'].includes(latest.status) && <button disabled={busy || running} onClick={() => void act(() => window.api.taskGraph.discardTask({ projectId, taskId: task.id }))}>Versuch verwerfen</button>}
        {attempts.map(attempt => <details key={attempt.id} ref={el => { if (el) attemptRefs.current.set(attempt.id, el) }}><summary>Versuch {attempt.id.slice(0, 8)} · {STATUSES[attempt.status]}</summary>
          <p>{attempt.implementerId} → {attempt.reviewerId}{attempt.challengerId ? ` → ${attempt.challengerId}` : ''}</p>
          {attempt.verification.map((v, i) => <details key={i}><summary>{v.success ? '✓' : '✕'} {v.command.executable} {v.command.args.join(' ')} · Exit {v.exitCode ?? '–'} · {v.durationMs} ms</summary><pre>{v.stdout}{v.stderr}</pre></details>)}
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
            <summary>Agent-Protokoll</summary>
            {openProtocols.has(attempt.id) && <pre style={{ maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(attemptEvents.get(attempt.id) ?? [], null, 2)}</pre>}
          </details>
        </details>)}
      </div>
    })}
    <div className="row" style={{ marginTop: 16 }}>
      <button disabled={busy || running || !state?.commands.length || state.phase === 'done'} onClick={() => void act(() => window.api.taskGraph.runReadyTasks({ projectId, taskId: '', implementerId, reviewerId, challengerId: challengerId || undefined }))}>Bereite Tasks nacheinander ausführen und geprüfte Ergebnisse integrieren</button>
      <button disabled={busy || running || state?.phase === 'done'} onClick={() => void act(() => window.api.taskGraph.finalReview(projectId))}>Gesamtprüfungen und finales Council starten</button>
      {state?.phase === 'release_approval' && <button className="primary" disabled={busy} onClick={() => void act(() => window.api.taskGraph.release(projectId, state.releaseCommit!))}>Release freigeben: {state.releaseCommit?.slice(0, 12)}</button>}
    </div>
    {state?.finalVerification?.map((v, i) => <details key={i}><summary>Integrationsprüfung: {v.command.executable} {v.command.args.join(' ')} {v.success ? '✓' : '✕'}</summary><pre>{v.stdout}{v.stderr}</pre></details>)}
    {state?.finalVerdict && <pre>{JSON.stringify(state.finalVerdict, null, 2)}</pre>}
  </section>
}

function InstallApproval({ request, busy, onDecision }: {
  request: NonNullable<TaskAttempt['pendingInstallAction']>
  busy: boolean
  onDecision: (decision: RespondInstallRequestDto['decision']) => Promise<void>
}): React.JSX.Element {
  const [command, setCommand] = useState<CommandSpec>(() => structuredClone(request.suggestedCommand ?? {
    executable: '', args: [], timeoutMs: 600000
  }))
  const valid = !!command.executable.trim() && Number.isFinite(command.timeoutMs) && command.timeoutMs >= 100 && command.timeoutMs <= 3600000
  return <div className="result-card" style={{ marginTop: 8 }}>
    <p>Das Build-/Test-Werkzeug „{request.executable}“ wurde nicht gefunden. Der Lauf wartet auf deine Entscheidung.</p>
    <p>{request.suggestedCommand ? 'Prüfe den vorgeschlagenen Installationsbefehl und passe ihn bei Bedarf an.' : 'Kein Installationsbefehl bekannt. Gib einen passenden Befehl an oder lehne die Installation ab.'}</p>
    <label>Installationsprogramm <input disabled={busy} value={command.executable} onChange={e => setCommand({ ...command, executable: e.target.value })} /></label>
    {command.args.map((arg, index) => <div className="row" key={index}>
      <label>Argument {index + 1} <input disabled={busy} value={arg} onChange={e => setCommand({ ...command, args: command.args.map((a, i) => i === index ? e.target.value : a) })} /></label>
      <button disabled={busy} onClick={() => setCommand({ ...command, args: command.args.filter((_, i) => i !== index) })}>Argument entfernen</button>
    </div>)}
    <button disabled={busy} onClick={() => setCommand({ ...command, args: [...command.args, ''] })}>Argument hinzufügen</button>
    <label>Timeout in Sekunden <input disabled={busy} type="number" min={1} max={3600} value={command.timeoutMs / 1000} onChange={e => setCommand({ ...command, timeoutMs: Number(e.target.value) * 1000 })} /></label>
    <div className="row">
      <button disabled={busy} onClick={() => void onDecision({ approved: false })}>Installation ablehnen</button>
      <button className="primary" disabled={busy || !valid} onClick={() => void onDecision({ approved: true, command: { ...command, executable: command.executable.trim() } })}>Installieren und Prüfungen wiederholen</button>
    </div>
  </div>
}
