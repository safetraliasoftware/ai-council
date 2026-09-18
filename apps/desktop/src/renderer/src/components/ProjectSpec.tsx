import CouncilUsage from './CouncilUsage'
import type { CouncilCallUsage } from '@ai-council/council-core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilStage } from '@ai-council/council-core'
import type { ProjectSpecification, TaskGraphSnapshot } from '@ai-council/project-domain'
import type {
  GenerateSpecRequestDto,
  GenerateTaskGraphRequestDto,
  ProjectSpecGeneratedEnvelope,
  TaskGraphGeneratedEnvelope
} from '../../../main/ipc-types'
import TaskGraphExecution from './TaskGraphExecution'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']
const STAGE_TITLE_KEYS: Record<CouncilStage, string> = {
  independent: 'projectSpec.stageIndependent',
  critique: 'projectSpec.stageCritique',
  revision: 'projectSpec.stageRevision',
  synthesis: 'projectSpec.stageSynthesis'
}
const STATUS_KEYS: Record<ProjectSpecification['status'], string> = {
  draft: 'projectSpec.statusDraft',
  council_generated: 'projectSpec.statusCouncilGenerated',
  human_approved: 'projectSpec.statusHumanApproved',
  superseded: 'projectSpec.statusSuperseded',
  rejected: 'projectSpec.statusRejected'
}
const TASK_GRAPH_STATUS_KEYS: Record<TaskGraphSnapshot['status'], string> = {
  council_generated: 'projectSpec.statusCouncilGenerated',
  human_approved: 'projectSpec.statusHumanApproved',
  rejected: 'projectSpec.statusRejected'
}

interface EntryState {
  text: string
  done: boolean
  error?: string
  label?: string
  warning?: string
}
type StageState = Partial<Record<ProviderId, EntryState>>

const EMPTY_STAGES: Record<CouncilStage, StageState> = { independent: {}, critique: {}, revision: {}, synthesis: {} }

export interface ProjectSpecPrefill {
  id: number
  goal: string
  workingDirectory?: string
}

/**
 * Human gate before any code gets written: a raw goal goes to the council,
 * comes back as a structured, versioned ProjectSpecification, and only a
 * human "Genehmigen" click lets it move on (Phase B, not built yet). See
 * the plan at packages/task-graph for the full engine this feeds into.
 */
export default function ProjectSpec({ prefill }: { prefill: ProjectSpecPrefill | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectSpecification[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [history, setHistory] = useState<ProjectSpecification[]>([])
  const [goal, setGoal] = useState('')
  const [userNote, setUserNote] = useState('')
  // Stable id for a not-yet-submitted new project, minted client-side so a
  // working directory can be attached (project-directory-store.ts) before
  // any council run/spec version exists - the server already tolerates a
  // client-supplied projectId with no prior events as a fresh project.
  const [draftProjectId, setDraftProjectId] = useState<string>(() => crypto.randomUUID())
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [projectDirectory, setProjectDirectory] = useState<string | undefined>(undefined)
  const [directoryBusy, setDirectoryBusy] = useState(false)
  const [directoryError, setDirectoryError] = useState('')
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>()
  const lastAppliedPrefillId = useRef<number | undefined>(undefined)
  // Per open-question answers, keyed by index into latest.openQuestions -
  // composed into the note sent back to the council on "Neue Version
  // anfordern", so a blocking question can actually be answered instead of
  // only being visible. Reset alongside userNote whenever the open project
  // or its spec version changes.
  const [questionAnswers, setQuestionAnswers] = useState<Record<number, string>>({})
  const [selected, setSelected] = useState<ProviderId[]>(ALL_PROVIDERS)
  const [chairId, setChairId] = useState<ProviderId>('anthropic')
  const [deliberation, setDeliberation] = useState<'compact' | 'full'>('compact')
  const [planningProfile, setPlanningProfile] = useState<'simple' | 'standard'>('simple')
  const [running, setRunning] = useState(false)
  const [stages, setStages] = useState(EMPTY_STAGES)
  const [specUsage, setSpecUsage] = useState<CouncilCallUsage[]>([])
  const [graphUsage, setGraphUsage] = useState<CouncilCallUsage[]>([])
  const [result, setResult] = useState<ProjectSpecGeneratedEnvelope | null>(null)
  const currentRunId = useRef<string>('')
  // The live "Runde 1..4" progress renders near the top of the page, above
  // the current specification - but the button that starts a new version
  // (answer open questions, then "Antworten senden & neue Version
  // anfordern") sits much further down, next to those questions. Without
  // this, clicking it while scrolled down left the user staring at an
  // unchanged bottom of the page while the actual progress silently reset
  // and restarted far above, out of view - caught live.
  const stagesRef = useRef<HTMLDivElement>(null)

  const [taskGraph, setTaskGraph] = useState<TaskGraphSnapshot | null>(null)
  const [taskGraphRunning, setTaskGraphRunning] = useState(false)
  const [taskGraphStages, setTaskGraphStages] = useState(EMPTY_STAGES)
  const [taskGraphResult, setTaskGraphResult] = useState<TaskGraphGeneratedEnvelope | null>(null)
  const taskGraphRunId = useRef<string>('')

  const reloadProjects = async (): Promise<void> => {
    setProjects(await window.api.projectSpec.list())
  }

  const reloadHistory = async (projectId: string): Promise<void> => {
    setHistory(await window.api.projectSpec.history(projectId))
  }

  const reloadTaskGraph = async (projectId: string): Promise<void> => {
    setTaskGraph((await window.api.taskGraph.get(projectId)) ?? null)
  }

  useEffect(() => {
    reloadProjects()
  }, [])

  useEffect(() => {
    window.api.settings.getWorkspaceRoot().then(setWorkspaceRoot)
  }, [])

  // Applies a handoff from the Coding tab exactly once per prefill (guarded
  // by id, since the same prefill object would otherwise re-apply on every
  // unrelated re-render). A fresh draftProjectId is minted here too, so the
  // handed-off goal/directory attach to a genuinely new project rather than
  // whatever was previously selected.
  useEffect(() => {
    if (!prefill || lastAppliedPrefillId.current === prefill.id) return
    lastAppliedPrefillId.current = prefill.id
    setSelectedProjectId(null)
    setHistory([])
    setResult(null)
    setStages(EMPTY_STAGES)
    setSpecUsage([])
    setTaskGraph(null)
    setTaskGraphResult(null)
    setTaskGraphStages(EMPTY_STAGES)
    setGraphUsage([])
    setGoal(prefill.goal)
    setUserNote('')
    setQuestionAnswers({})
    const id = crypto.randomUUID()
    setDraftProjectId(id)
    setProjectDirectory(undefined)
    setDirectoryError('')
    if (prefill.workingDirectory) {
      setWorkingDirectory(prefill.workingDirectory)
      void (async (): Promise<void> => {
        setDirectoryBusy(true)
        try {
          const result = await window.api.projectSpec.setWorkingDirectory({ projectId: id, workingDirectory: prefill.workingDirectory! })
          if (result.ok) setProjectDirectory(prefill.workingDirectory)
          else setDirectoryError(result.error ?? t('projectSpec.folderTakeoverFailed'))
        } finally {
          setDirectoryBusy(false)
        }
      })()
    } else {
      setWorkingDirectory('')
    }
  }, [prefill])

  useEffect(() => {
    const offCouncil = window.api.projectSpec.onCouncilEvent((e) => {
      if (e.runId !== currentRunId.current) return
      if (e.kind === 'run_done') { setSpecUsage(e.usage ?? []); return }
      if (!e.stage) return
      const stage = e.stage
      const { providerId, event, label } = e
      setStages((s) => {
        const stageState = s[stage]
        const current = stageState[providerId] ?? { text: '', done: false }
        let next: EntryState = current
        switch (event.type) {
          case 'text_delta':
            next = { ...current, text: current.text + event.text, label }
            break
          case 'done':
            next = { ...current, text: event.result.text, done: true, label }
            break
          case 'error':
            next = { ...current, done: true, error: event.error.message, label }
            break
          case 'warning':
            next = { ...current, warning: event.message, label }
            break
          case 'policy_violation':
            next = { ...current, warning: event.message, label }
            break
          default:
            return s
        }
        return { ...s, [stage]: { ...stageState, [providerId]: next } }
      })
    })
    const offGenerated = window.api.projectSpec.onGenerated((envelope) => {
      setRunning(false)
      setResult(envelope)
      setSelectedProjectId(envelope.projectId)
      setUserNote('')
      setQuestionAnswers({})
      void reloadProjects()
      void reloadHistory(envelope.projectId)
    })
    return (): void => {
      offCouncil()
      offGenerated()
    }
  }, [])

  useEffect(() => {
    const offCouncil = window.api.taskGraph.onCouncilEvent((e) => {
      if (e.runId !== taskGraphRunId.current) return
      if (e.kind === 'run_done') { setGraphUsage(e.usage ?? []); return }
      if (!e.stage) return
      const stage = e.stage
      const { providerId, event, label } = e
      setTaskGraphStages((s) => {
        const stageState = s[stage]
        const current = stageState[providerId] ?? { text: '', done: false }
        let next: EntryState = current
        switch (event.type) {
          case 'text_delta':
            next = { ...current, text: current.text + event.text, label }
            break
          case 'done':
            next = { ...current, text: event.result.text, done: true, label }
            break
          case 'error':
            next = { ...current, done: true, error: event.error.message, label }
            break
          case 'warning':
            next = { ...current, warning: event.message, label }
            break
          case 'policy_violation':
            next = { ...current, warning: event.message, label }
            break
          default:
            return s
        }
        return { ...s, [stage]: { ...stageState, [providerId]: next } }
      })
    })
    const offGenerated = window.api.taskGraph.onGenerated((envelope) => {
      setTaskGraphRunning(false)
      setTaskGraphResult(envelope)
      if (envelope.ok) setTaskGraph(envelope.snapshot)
    })
    return (): void => {
      offCouncil()
      offGenerated()
    }
  }, [])

  const toggle = (p: ProviderId): void => {
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))
  }

  const canRun = goal.trim() && selected.length >= 2 && selected.includes(chairId)

  const startNewProject = (): void => {
    setSelectedProjectId(null)
    setHistory([])
    setGoal('')
    setUserNote('')
    setQuestionAnswers({})
    setResult(null)
    setStages(EMPTY_STAGES)
    setSpecUsage([])
    setTaskGraph(null)
    setTaskGraphResult(null)
    setTaskGraphStages(EMPTY_STAGES)
    setGraphUsage([])
    setDraftProjectId(crypto.randomUUID())
    setWorkingDirectory('')
    setProjectDirectory(undefined)
    setDirectoryError('')
  }

  const openProject = async (projectId: string): Promise<void> => {
    setSelectedProjectId(projectId)
    setResult(null)
    setUserNote('')
    setQuestionAnswers({})
    setStages(EMPTY_STAGES)
    setSpecUsage([])
    setTaskGraphResult(null)
    setTaskGraphStages(EMPTY_STAGES)
    setGraphUsage([])
    setDirectoryError('')
    await Promise.all([reloadHistory(projectId), reloadTaskGraph(projectId)])
    const proj = projects.find((p) => p.id === projectId)
    if (proj) setGoal(proj.goal)
    const dir = await window.api.projectSpec.getWorkingDirectory(projectId)
    setProjectDirectory(dir)
    setWorkingDirectory(dir ?? '')
  }

  const saveDirectory = async (projectId: string): Promise<void> => {
    if (!workingDirectory.trim()) return
    setDirectoryBusy(true)
    setDirectoryError('')
    try {
      const result = await window.api.projectSpec.setWorkingDirectory({ projectId, workingDirectory })
      if (result.ok) setProjectDirectory(workingDirectory)
      else setDirectoryError(result.error ?? t('projectSpec.folderSetupFailed'))
    } finally {
      setDirectoryBusy(false)
    }
  }

  /**
   * Merges the free-text note with per-question answers into one note sent
   * back to the council - a blocking open question can now actually be
   * answered instead of only being visible, which should also reduce the
   * ambiguity that was likely behind slow/prose-instead-of-JSON responses
   * observed live during task graph generation.
   */
  const composeRevisionNote = (): string => {
    const answeredQuestions = (latest?.openQuestions ?? [])
      .map((q, i) => ({ q, answer: questionAnswers[i]?.trim() }))
      .filter((x) => x.answer)
      .map((x) => t('projectSpec.answerToQuestion', { question: x.q.text, answer: x.answer }))
      .join('\n')
    return [userNote.trim(), answeredQuestions].filter(Boolean).join('\n\n')
  }

  const run = async (): Promise<void> => {
    if (!canRun) return
    setRunning(true)
    setResult(null)
    setStages(EMPTY_STAGES)
    setSpecUsage([])
    stagesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    const req: GenerateSpecRequestDto = {
      planningProfile,
      deliberation,
      projectId: selectedProjectId ?? draftProjectId,
      goal,
      providers: selected,
      chairId,
      userNote: selectedProjectId ? composeRevisionNote() : undefined
    }
    try {
      const { runId } = await window.api.projectSpec.generate(req)
      if (!runId) throw new Error(t('projectSpec.specRunStartFailed'))
      currentRunId.current = runId
    } catch (err) {
      setRunning(false)
      setResult({ projectId: selectedProjectId ?? '', ok: false, error: String(err), rawText: '' })
    }
  }

  const cancel = async (): Promise<void> => {
    if (currentRunId.current) await window.api.projectSpec.cancel(currentRunId.current)
    setRunning(false)
  }

  const latest = history[history.length - 1]

  const approve = async (): Promise<void> => {
    if (!selectedProjectId || !latest) return
    const hasBlockingOpen = latest.openQuestions.some((q) => q.blocking)
    const hasUnsentAnswers = Object.values(questionAnswers).some((a) => a?.trim())
    if (hasBlockingOpen) {
      // Answering a question here only drafts text for "Neue Version
      // anfordern" - it never reaches the council on its own. Caught live:
      // easy to answer every question, then click the nearby "Genehmigen"
      // right below them instead of the "Neue Version anfordern" button
      // further up, silently discarding the answers.
      const proceed = window.confirm(
        hasUnsentAnswers
          ? t('projectSpec.confirmApproveWithUnsentAnswers')
          : t('projectSpec.confirmApproveWithBlockingQuestions')
      )
      if (!proceed) return
    }
    await window.api.projectSpec.approve(selectedProjectId, latest.version)
    await Promise.all([reloadProjects(), reloadHistory(selectedProjectId)])
  }

  const reject = async (): Promise<void> => {
    if (!selectedProjectId || !latest) return
    await window.api.projectSpec.reject(selectedProjectId, latest.version)
    await Promise.all([reloadProjects(), reloadHistory(selectedProjectId)])
  }

  const generateTaskGraph = async (): Promise<void> => {
    if (!selectedProjectId || !latest) return
    setTaskGraphRunning(true)
    setTaskGraphResult(null)
    setTaskGraphStages(EMPTY_STAGES)
    setGraphUsage([])
    const req: GenerateTaskGraphRequestDto = {
      planningProfile,
      deliberation,
      projectId: selectedProjectId,
      specVersion: latest.version,
      providers: selected,
      chairId
    }
    try {
      const { runId } = await window.api.taskGraph.generate(req)
      if (!runId) throw new Error(t('projectSpec.taskGraphStartFailed'))
      taskGraphRunId.current = runId
    } catch (err) {
      setTaskGraphRunning(false)
      setTaskGraphResult({ projectId: selectedProjectId, ok: false, error: String(err), rawText: '' })
    }
  }

  const cancelTaskGraph = async (): Promise<void> => {
    if (taskGraphRunId.current) await window.api.taskGraph.cancel(taskGraphRunId.current)
    setTaskGraphRunning(false)
  }

  const approveTaskGraph = async (): Promise<void> => {
    if (!selectedProjectId) return
    await window.api.taskGraph.approve(selectedProjectId)
    await reloadTaskGraph(selectedProjectId)
  }

  const rejectTaskGraph = async (): Promise<void> => {
    if (!selectedProjectId) return
    await window.api.taskGraph.reject(selectedProjectId)
    await reloadTaskGraph(selectedProjectId)
  }

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>{t('projectSpec.projectsHeading')}</h3>
          <button className="secondary" onClick={startNewProject}>
            {t('projectSpec.newProject')}
          </button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          {projects.length === 0 && (
            <span className="status-neutral">{t('projectSpec.noProjectsYet')}</span>
          )}
          {projects.map((p) => (
            <button
              key={p.id}
              className={`tab ${selectedProjectId === p.id ? 'active' : ''}`}
              onClick={() => openProject(p.id)}
            >
              {p.goal.length > 40 ? `${p.goal.slice(0, 40)}…` : p.goal} (v{p.version})
            </button>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        {selectedProjectId ? (
          <div className="field">
            <label>{t('projectSpec.goalOfProjectLabel')}</label>
            <p style={{ marginTop: 0 }}>{goal}</p>
            <label>{t('projectSpec.revisionNoteLabel')}</label>
            <textarea
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder={t('projectSpec.revisionNotePlaceholder')}
            />
          </div>
        ) : (
          <div className="field">
            <label>{t('projectSpec.taskLabel')}</label>
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={t('projectSpec.taskPlaceholder')}
            />
          </div>
        )}

        <div className="field">
          <label>{t('projectSpec.workingDirLabel')}{projectDirectory ? '' : t('projectSpec.workingDirOptionalSuffix')}</label>
          {projectDirectory ? (
            <p className="status-neutral" style={{ marginTop: 0 }}>{projectDirectory}</p>
          ) : (
            <>
              <input value={workingDirectory} onChange={(e) => setWorkingDirectory(e.target.value)} placeholder={t('projectSpec.workingDirPlaceholder')} />
              {workspaceRoot && (
                <p className="status-neutral">
                  {t('projectSpec.workspaceRootHint', { path: workspaceRoot })}
                </p>
              )}
              <div className="row">
                <button
                  className="secondary"
                  onClick={() =>
                    void (async (): Promise<void> => {
                      const path = await window.api.coding.pickDirectory()
                      if (path) setWorkingDirectory(path)
                    })()
                  }
                >
                  {t('projectSpec.browse')}
                </button>
                {workspaceRoot && (
                  <button className="secondary" onClick={() => setWorkingDirectory(`${workspaceRoot}\\`)}>
                    {t('projectSpec.createInWorkspaceRoot')}
                  </button>
                )}
                <button
                  className="secondary"
                  disabled={directoryBusy || !workingDirectory.trim()}
                  onClick={() => void saveDirectory(selectedProjectId ?? draftProjectId)}
                >
                  {directoryBusy ? t('projectSpec.running') : t('projectSpec.setFolder')}
                </button>
              </div>
              {directoryError && <p className="error-text">{directoryError}</p>}
            </>
          )}
        </div>

        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div className="row">
            {ALL_PROVIDERS.map((p) => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <input type="checkbox" checked={selected.includes(p)} onChange={() => toggle(p)} style={{ width: 'auto' }} />
                {PROVIDER_LABELS[p]}
              </label>
            ))}
          </div>
          <div className="row">
            <label style={{ margin: 0 }}>{t('projectSpec.planningLabel')}
              <select value={deliberation} disabled={running || taskGraphRunning}
                onChange={(e) => setDeliberation(e.target.value as 'compact' | 'full')}>
                <option value="compact">{t('projectSpec.deliberationCompact')}</option>
                <option value="full">{t('projectSpec.deliberationFull')}</option>
              </select>
            </label>
            <label style={{ margin: 0 }}>{t('projectSpec.projectScopeLabel')}
              <select value={planningProfile} disabled={running || taskGraphRunning} onChange={e => setPlanningProfile(e.target.value as 'simple' | 'standard')}>
                <option value="simple">{t('projectSpec.profileSimple')}</option>
                <option value="standard">{t('projectSpec.profileStandard')}</option>
              </select>
            </label>
            <label style={{ margin: 0 }}>{t('projectSpec.chairLabel')}</label>
            <select value={chairId} onChange={(e) => setChairId(e.target.value as ProviderId)} style={{ width: 140 }}>
              {selected.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            {running && (
              <button className="secondary" onClick={cancel}>
                {t('projectSpec.cancel')}
              </button>
            )}
            <button className="primary" onClick={run} disabled={running || !canRun}>
              {running ? t('projectSpec.running') : selectedProjectId ? t('projectSpec.requestNewVersion') : t('projectSpec.conveneCouncil')}
            </button>
          </div>
        </div>
        {selected.length < 2 && (
          <p className="status-neutral" style={{ marginBottom: 0 }}>
            {t('projectSpec.minTwoProviders')}
          </p>
        )}
      </div>

      <div ref={stagesRef}>
        <CouncilUsage calls={specUsage} />
        {(Object.keys(stages) as CouncilStage[]).map((stage) => {
          const entries = Object.entries(stages[stage]) as [ProviderId, EntryState][]
          if (entries.length === 0) return null
          return (
            <div key={stage} style={{ marginTop: 20 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--text-muted)' }}>{t(STAGE_TITLE_KEYS[stage])}</h3>
              <div className="columns">
                {entries.map(([providerId, entry]) => (
                  <div key={providerId} className="result-card">
                    <div className="result-header">
                      <span className={`provider-dot dot-${providerId}`} />
                      {PROVIDER_LABELS[providerId]}
                      {entry.label && <span className="badge" style={{ marginLeft: 6 }}>{entry.label}</span>}
                      {!entry.done && <span className="status-neutral">{t('projectSpec.runningShort')}</span>}
                    </div>
                    <div className="result-body">
                      {entry.warning && <div className="error-text">⚠ {entry.warning}</div>}
                      {entry.error ? (
                        <>
                          <div className="error-text">⚠ {t('projectSpec.participantFailed', { error: entry.error })}</div>
                          <div className="status-neutral" style={{ fontSize: 12, marginTop: 4 }}>
                            {t('projectSpec.othersContinue')}
                          </div>
                        </>
                      ) : (
                        entry.text || <span className="status-neutral">{t('projectSpec.waiting')}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {result && !result.ok && (
        <div className="panel" style={{ marginTop: 20 }}>
          <p className="error-text">{t('projectSpec.parseFailedError', { error: result.error })}</p>
          <div className="result-body" style={{ maxHeight: 300 }}>
            {result.rawText}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="primary" onClick={run} disabled={running}>
              {t('projectSpec.regenerate')}
            </button>
          </div>
        </div>
      )}

      {latest && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>
              {t('projectSpec.specVersionHeading', { version: latest.version })}
              {latest.supersedesVersion !== undefined && (
                <span className="status-neutral"> {t('projectSpec.supersedesSuffix', { version: latest.supersedesVersion })}</span>
              )}
            </h3>
            <span className="badge">{t(STATUS_KEYS[latest.status])}</span>
          </div>
          <p style={{ color: 'var(--text-muted)' }}>
            {t('projectSpec.synthesisChairLine', { provider: PROVIDER_LABELS[latest.chairId] })}
          </p>

          <h4>{t('projectSpec.requirementsHeading')}</h4>
          {latest.requirements.map((r) => (
            <div key={r.id} className="result-card" style={{ marginBottom: 8, minHeight: 0 }}>
              <div className="result-header">
                <span className="badge">{r.id}</span>
                <span className="badge">{r.category}</span>
                {r.priority && <span className="badge">{r.priority}</span>}
              </div>
              <div className="result-body">
                <div>{r.statement}</div>
                {r.acceptanceCriteria.length > 0 && (
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {r.acceptanceCriteria.map((ac, i) => (
                      <li key={i} style={{ fontSize: 12 }}>
                        {ac}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}

          {latest.nonGoals.length > 0 && (
            <>
              <h4>{t('projectSpec.nonGoalsHeading')}</h4>
              <ul>
                {latest.nonGoals.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </>
          )}

          {latest.architectureNotes && (
            <>
              <h4>{t('projectSpec.architectureNotesHeading')}</h4>
              <p>{latest.architectureNotes}</p>
            </>
          )}

          {latest.risks.length > 0 && (
            <>
              <h4>{t('projectSpec.risksHeading')}</h4>
              <ul>
                {latest.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}

          {latest.openQuestions.length > 0 && (
            <>
              <h4>{t('projectSpec.openQuestionsHeading')}</h4>
              <p style={{ color: 'var(--text-muted)', marginTop: 0, fontSize: 13 }}>
                {t('projectSpec.openQuestionsHint')}
              </p>
              {latest.openQuestions.map((q, i) => (
                <div key={i} className="field" style={{ marginBottom: 10 }}>
                  <label className={q.blocking ? 'error-text' : undefined} style={{ fontWeight: 400 }}>
                    {q.blocking ? `⚠ ${t('projectSpec.blockingPrefix')}` : ''}
                    {q.text}
                  </label>
                  <textarea
                    value={questionAnswers[i] ?? ''}
                    onChange={(e) => setQuestionAnswers((a) => ({ ...a, [i]: e.target.value }))}
                    placeholder={t('projectSpec.answerPlaceholder')}
                    style={{ minHeight: 44 }}
                  />
                </div>
              ))}
              <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
                <button className="primary" onClick={run} disabled={running || !canRun}>
                  {running ? t('projectSpec.running') : t('projectSpec.sendAnswersAndRequestVersion')}
                </button>
              </div>
            </>
          )}

          {latest.status === 'council_generated' && (
            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="secondary" onClick={reject}>
                {t('projectSpec.reject')}
              </button>
              <button className="primary" onClick={approve}>
                {t('projectSpec.approve')}
              </button>
            </div>
          )}

          {latest.status === 'human_approved' && (
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
              <p className="status-neutral" style={{ margin: 0 }}>
                {taskGraph
                  ? (taskGraph.tasks.length === 1 ? t('projectSpec.taskGraphExistsSingular') : t('projectSpec.taskGraphExistsPlural', { count: taskGraph.tasks.length }))
                  : t('projectSpec.noTaskGraphYet')}
              </p>
              <div className="row">
                {taskGraphRunning && (
                  <button className="secondary" onClick={cancelTaskGraph}>
                    {t('projectSpec.cancel')}
                  </button>
                )}
                <button className="primary" onClick={generateTaskGraph} disabled={taskGraphRunning}>
                  {taskGraphRunning ? t('projectSpec.running') : taskGraph ? t('projectSpec.regenerateTaskGraph') : t('projectSpec.generateTaskGraph')}
                </button>
              </div>
            </div>
          )}

          {history.length > 1 && (
            <>
              <h4 style={{ marginTop: 16 }}>{t('projectSpec.versionHistoryHeading')}</h4>
              {history.map((v) => (
                <div key={v.version} className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
                  <span className="badge">v{v.version}</span>
                  <span className="status-neutral">{t(STATUS_KEYS[v.status])}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <CouncilUsage calls={graphUsage} />
      {(Object.keys(taskGraphStages) as CouncilStage[]).map((stage) => {
        const entries = Object.entries(taskGraphStages[stage]) as [ProviderId, EntryState][]
        if (entries.length === 0) return null
        return (
          <div key={stage} style={{ marginTop: 20 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--text-muted)' }}>{t(STAGE_TITLE_KEYS[stage])}</h3>
            <div className="columns">
              {entries.map(([providerId, entry]) => (
                <div key={providerId} className="result-card">
                  <div className="result-header">
                    <span className={`provider-dot dot-${providerId}`} />
                    {PROVIDER_LABELS[providerId]}
                    {entry.label && <span className="badge" style={{ marginLeft: 6 }}>{entry.label}</span>}
                    {!entry.done && <span className="status-neutral">{t('projectSpec.runningShort')}</span>}
                  </div>
                  <div className="result-body">
                    {entry.warning && <div className="error-text">⚠ {entry.warning}</div>}
                    {entry.error ? <span className="error-text">{entry.error}</span> : entry.text || <span className="status-neutral">{t('projectSpec.waiting')}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}

      {taskGraphResult && !taskGraphResult.ok && (
        <div className="panel" style={{ marginTop: 20 }}>
          <p className="error-text">{t('projectSpec.taskGraphGenerationFailed', { error: taskGraphResult.error })}</p>
          <div className="result-body" style={{ maxHeight: 300 }}>
            {taskGraphResult.rawText}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="primary" onClick={generateTaskGraph} disabled={taskGraphRunning}>
              {t('projectSpec.regenerate')}
            </button>
          </div>
        </div>
      )}

      {taskGraph && (
        <div className="panel" style={{ marginTop: 20 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>{t('projectSpec.taskGraphHeading', { version: taskGraph.specVersion })}</h3>
            <span className="badge">{t(TASK_GRAPH_STATUS_KEYS[taskGraph.status])}</span>
          </div>
          <p style={{ color: 'var(--text-muted)' }}>{t('projectSpec.synthesisChairLine', { provider: PROVIDER_LABELS[taskGraph.chairId] })}</p>

          {taskGraph.status === 'human_approved' ? (
            <TaskGraphExecution
              key={taskGraph.projectId}
              projectId={taskGraph.projectId}
              taskGraph={taskGraph}
              onChanged={() => reloadTaskGraph(taskGraph.projectId)}
              onRequestSpecRevision={(note) => {
                setUserNote(note)
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            />
          ) : (
            <>
              {taskGraph.tasks.map((task) => (
                <div key={task.id} className="result-card" style={{ marginBottom: 8, minHeight: 0 }}>
                  <div className="result-header">
                    <span className="badge">{task.id}</span>
                    {task.requirementIds.map((r) => (
                      <span key={r} className="badge">
                        {r}
                      </span>
                    ))}
                  </div>
                  <div className="result-body">
                    <div style={{ fontWeight: 600 }}>{task.title}</div>
                    <div>{task.description}</div>
                    {task.dependencies.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                        {t('projectSpec.dependsOn')}{' '}
                        {task.dependencies.map((d) => `${d.taskId} (${d.impact})`).join(', ')}
                      </div>
                    )}
                    {task.scope.allowedPaths.length > 0 && (
                      <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                        {t('projectSpec.scopeLabel')}{task.scope.allowedPaths.join(', ')}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {taskGraph.status === 'council_generated' && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
                  <button className="secondary" onClick={rejectTaskGraph}>
                    {t('projectSpec.reject')}
                  </button>
                  <button className="primary" onClick={approveTaskGraph}>
                    {t('projectSpec.approve')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
