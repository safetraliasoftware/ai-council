import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { PermissionTier } from '@ai-council/coding'
import type { CodingDetectResult, CodingExecutorId, HistoryListEntry } from '../../../main/ipc-types'
import { CODING_EXECUTOR_LABELS, PERMISSION_TIER_LABELS } from '../../../main/ipc-types'
import { applyCodingEvent, LogLine, type LogEntry } from '../codingEventDisplay'
import ProjectPicker from '../ProjectPicker'

const EXECUTORS: CodingExecutorId[] = ['claude-code-cli', 'openai-codex-cli', 'google-antigravity-cli', 'grok-build-cli']
const PERMISSION_TIERS: PermissionTier[] = ['read-only', 'read-write', 'full']

export interface TaskCodingProps {
  onHandoffToWorkflow: (data: { task: string; workingDirectory: string; implementerId: CodingExecutorId }) => void
}

interface PlanItem {
  title: string
  body: string
}

/**
 * Splits a Coding-tab answer into numbered plan items (e.g. "1. **Fix X.**
 * ...\n\n2. **Fix Y.** ..."), if it looks like a numbered list at all. A
 * plan like this isn't one concrete task - handing the whole blob to the
 * Workflow tab as-is trips the "keine Dateiänderungen" guard, since no
 * single implementer run can sensibly address seven unrelated points at
 * once. Returns [] when fewer than two numbered items are found, so the
 * caller can fall back to handing off the whole answer unchanged.
 */
function parsePlanItems(text: string, t: TFunction): PlanItem[] {
  const matches = [...text.matchAll(/^\d+\.\s+/gm)]
  if (matches.length < 2) return []

  const items: PlanItem[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length
    const body = text.slice(start, end).trim()
    const firstLine = body.split('\n')[0].replace(/^\d+\.\s+/, '').replace(/\*\*/g, '').trim()
    items.push({ title: firstLine || t('taskCoding.fallbackPointTitle', { n: i + 1 }), body })
  }
  return items
}

export default function TaskCoding({ onHandoffToWorkflow }: TaskCodingProps): React.JSX.Element {
  const { t } = useTranslation()
  const [executorId, setExecutorId] = useState<CodingExecutorId>('claude-code-cli')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [permissionTier, setPermissionTier] = useState<PermissionTier>('read-only')
  const [prompt, setPrompt] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [running, setRunning] = useState(false)
  const [startError, setStartError] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [detect, setDetect] = useState<Partial<Record<CodingExecutorId, CodingDetectResult>>>({})
  const [planPicker, setPlanPicker] = useState<PlanItem[] | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyList, setHistoryList] = useState<HistoryListEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const currentTaskId = useRef<string>('')
  const activeExecutorId = useRef<CodingExecutorId>(executorId)
  const waitingForTaskId = useRef(false)
  const pendingCodingEvents = useRef<{ taskId: string; event: Parameters<typeof applyCodingEvent>[1] }[]>([])
  // Kept stable across follow-ups (unlike `prompt`, which the input reuses)
  // so every history save for this session/session-continuation still shows
  // the task that started it.
  const historyPromptRef = useRef('')
  const historyStartedAtRef = useRef(0)
  // Mirrors `logs` imperatively so the value used for a history save is
  // never at the mercy of React's setState-updater batching timing (React
  // doesn't guarantee an updater passed to setLogs runs synchronously
  // before the next line of this callback executes) - logsRef.current is
  // always exactly what was just computed, no matter when React gets
  // around to committing the corresponding render.
  const logsRef = useRef<LogEntry[]>([])

  const saveToHistory = (finalLogs: LogEntry[], sid: string | undefined): void => {
    if (!historyPromptRef.current) return
    void window.api.history.saveCodingRun({
      executorId: activeExecutorId.current,
      workingDirectory,
      permissionTier,
      prompt: historyPromptRef.current,
      logs: finalLogs,
      sessionId: sid,
      startedAt: historyStartedAtRef.current,
      finishedAt: Date.now()
    })
  }

  const handleCodingEvent = (taskId: string, event: Parameters<typeof applyCodingEvent>[1]): void => {
    if (taskId !== currentTaskId.current) return
    const updatedLogs = applyCodingEvent(logsRef.current, event)
    logsRef.current = updatedLogs
    setLogs(updatedLogs)
    if (event.type === 'error') {
      setRunning(false)
      saveToHistory(updatedLogs, undefined)
    }
    if (event.type === 'done') {
      setRunning(false)
      setSessionId(event.sessionId)
      saveToHistory(updatedLogs, event.sessionId)
    }
  }
  const handleCodingEventRef = useRef(handleCodingEvent)
  handleCodingEventRef.current = handleCodingEvent

  useEffect(() => {
    const off = window.api.coding.onEvent(({ executorId: fromExecutor, taskId, event }) => {
      if (fromExecutor !== activeExecutorId.current) return
      if (waitingForTaskId.current) {
        pendingCodingEvents.current.push({ taskId, event })
        return
      }
      handleCodingEventRef.current(taskId, event)
    })
    return off
  }, [])

  const runDetect = async (id: CodingExecutorId): Promise<void> => {
    const result = await window.api.coding.detect(id)
    setDetect((d) => ({ ...d, [id]: result }))
  }

  const pickDirectory = async (): Promise<void> => {
    const dir = await window.api.coding.pickDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const run = async (): Promise<void> => {
    if (!prompt.trim() || !workingDirectory.trim()) return
    setRunning(true)
    setStartError('')
    logsRef.current = []
    setLogs([])
    setSessionId(undefined)
    setPlanPicker(null)
    historyPromptRef.current = prompt
    historyStartedAtRef.current = Date.now()
    activeExecutorId.current = executorId
    waitingForTaskId.current = true
    pendingCodingEvents.current = []
    try {
      const { taskId, error } = await window.api.coding.startTask({
        executorId,
        prompt,
        workingDirectory,
        permissionTier
      })
      if (!taskId) throw new Error(error ?? t('taskCoding.startTaskFailed'))
      currentTaskId.current = taskId
      waitingForTaskId.current = false
      for (const pending of pendingCodingEvents.current) handleCodingEvent(pending.taskId, pending.event)
      pendingCodingEvents.current = []
    } catch (err) {
      waitingForTaskId.current = false
      pendingCodingEvents.current = []
      // Without this, any rejection here left "Läuft…" stuck forever with
      // nothing visible - caught live.
      setRunning(false)
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  const sendFollowUp = async (): Promise<void> => {
    if (!followUp.trim() || !sessionId) return
    setRunning(true)
    setStartError('')
    logsRef.current = [...logsRef.current, { kind: 'status', message: t('taskCoding.youPrefix', { text: followUp }), count: 1 }]
    setLogs(logsRef.current)
    activeExecutorId.current = executorId
    waitingForTaskId.current = true
    pendingCodingEvents.current = []
    try {
      const { taskId, error } = await window.api.coding.resumeSession({
        executorId,
        prompt: followUp,
        workingDirectory,
        permissionTier,
        sessionId
      })
      if (!taskId) throw new Error(error ?? t('taskCoding.followUpFailed'))
      currentTaskId.current = taskId
      waitingForTaskId.current = false
      for (const pending of pendingCodingEvents.current) handleCodingEvent(pending.taskId, pending.event)
      pendingCodingEvents.current = []
      setFollowUp('')
    } catch (err) {
      waitingForTaskId.current = false
      pendingCodingEvents.current = []
      setRunning(false)
      setStartError(err instanceof Error ? err.message : String(err))
    }
  }

  const abort = async (): Promise<void> => {
    if (currentTaskId.current) await window.api.coding.abort(activeExecutorId.current, currentTaskId.current)
    setRunning(false)
  }

  const handoff = (): void => {
    const lastText = [...logs].reverse().find((e): e is Extract<LogEntry, { kind: 'text' }> => e.kind === 'text')
    if (!lastText || !workingDirectory.trim()) return
    const items = parsePlanItems(lastText.text, t)
    if (items.length >= 2) {
      setPlanPicker(items)
      return
    }
    onHandoffToWorkflow({ task: lastText.text, workingDirectory, implementerId: executorId })
  }

  const handoffPlanItem = (item: PlanItem): void => {
    setPlanPicker(null)
    onHandoffToWorkflow({ task: item.body, workingDirectory, implementerId: executorId })
  }

  const handoffWholeText = (): void => {
    const lastText = [...logs].reverse().find((e): e is Extract<LogEntry, { kind: 'text' }> => e.kind === 'text')
    setPlanPicker(null)
    if (!lastText) return
    onHandoffToWorkflow({ task: lastText.text, workingDirectory, implementerId: executorId })
  }

  const hasAnswer = logs.some((e) => e.kind === 'text')

  const status = detect[executorId]

  const toggleHistory = async (): Promise<void> => {
    if (historyOpen) {
      setHistoryOpen(false)
      return
    }
    setHistoryOpen(true)
    setHistoryLoading(true)
    setHistoryList(await window.api.history.list('coding'))
    setHistoryLoading(false)
  }

  const loadHistoryRun = async (id: string): Promise<void> => {
    const record = await window.api.history.get(id)
    if (!record || record.kind !== 'coding') return
    setExecutorId(record.executorId)
    setWorkingDirectory(record.workingDirectory)
    setPermissionTier(record.permissionTier ?? 'read-only')
    setPrompt(record.prompt)
    logsRef.current = record.logs
    setLogs(record.logs)
    setSessionId(record.sessionId)
    historyPromptRef.current = record.prompt
    historyStartedAtRef.current = record.startedAt
    setPlanPicker(null)
    setHistoryOpen(false)
  }

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            {t('taskCoding.description')}
          </p>
          <button className="secondary" onClick={toggleHistory}>
            {historyOpen ? t('taskCoding.closeHistory') : t('taskCoding.history')}
          </button>
        </div>

        {historyOpen && (
          <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
            {historyLoading && <span className="status-neutral">{t('taskCoding.loading')}</span>}
            {!historyLoading && historyList.length === 0 && (
              <span className="status-neutral">{t('taskCoding.noSavedRuns')}</span>
            )}
            {!historyLoading &&
              historyList.map((h) => (
                <div
                  key={h.id}
                  className="row"
                  style={{ cursor: 'pointer', marginBottom: 6, alignItems: 'flex-start' }}
                  onClick={() => loadHistoryRun(h.id)}
                >
                  <span className={h.outcome === 'error' ? 'status-bad' : 'status-ok'} style={{ minWidth: 14 }}>
                    {h.outcome === 'error' ? '✕' : '✓'}
                  </span>
                  <div>
                    <div style={{ fontSize: 13 }}>{h.summary}</div>
                    <div className="status-neutral" style={{ fontSize: 11 }}>
                      {new Date(h.startedAt).toLocaleString('de-DE')} · {h.workingDirectory}
                    </div>
                  </div>
                </div>
              ))}
          </div>
        )}

        <div className="field">
          <label>{t('taskCoding.executorLabel')}</label>
          <div className="row">
            <select
              value={executorId}
              disabled={running}
              onChange={(e) => setExecutorId(e.target.value as CodingExecutorId)}
              style={{ width: 200 }}
            >
              {EXECUTORS.map((id) => (
                <option key={id} value={id}>
                  {CODING_EXECUTOR_LABELS[id]}
                </option>
              ))}
            </select>
            <button className="secondary" onClick={() => runDetect(executorId)}>
              {t('taskCoding.checkAvailability')}
            </button>
            {status && (
              <span className={status.installed ? 'status-ok' : 'status-bad'}>
                {status.installed
                  ? t('taskCoding.installedWithVersion', { version: status.version ?? '?', status: t(`settings.auth.${status.authStatus}`) })
                  : t('taskCoding.notFound')}
              </span>
            )}
          </div>
        </div>

        <div className="field">
          <label>{t('taskCoding.workingDirLabel')}</label>
          <div className="row">
            <input
              type="text"
              value={workingDirectory}
              disabled={running}
              onChange={(e) => setWorkingDirectory(e.target.value)}
              placeholder={t('taskCoding.pathPlaceholder')}
            />
            <button className="secondary" disabled={running} onClick={pickDirectory}>
              {t('taskCoding.browse')}
            </button>
          </div>
          <ProjectPicker
            currentWorkingDirectory={workingDirectory}
            currentPermissionTier={permissionTier}
            onApply={(dir, tier) => {
              setWorkingDirectory(dir)
              if (tier) setPermissionTier(tier)
            }}
          />
        </div>

        <div className="field">
          <label>{t('taskCoding.permissionTierLabel')}</label>
          <select
            value={permissionTier}
            disabled={running}
            onChange={(e) => setPermissionTier(e.target.value as PermissionTier)}
            style={{ width: 260 }}
          >
            {PERMISSION_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {PERMISSION_TIER_LABELS[tier]}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>{t('taskCoding.taskLabel')}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('taskCoding.taskPlaceholder')}
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {running && (
            <button className="secondary" onClick={abort}>
              {t('taskCoding.cancel')}
            </button>
          )}
          <button
            className="primary"
            onClick={run}
            disabled={running || !prompt.trim() || !workingDirectory.trim()}
          >
            {running ? t('taskCoding.running') : t('taskCoding.start')}
          </button>
        </div>
        {startError && (
          <p className="error-text" style={{ marginBottom: 0 }}>
            {startError}
          </p>
        )}
      </div>

      {logs.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          {logs.map((entry, i) => (
            <LogLine key={i} entry={entry} />
          ))}

          {sessionId && (
            <div className="row" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <input
                type="text"
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !running && sendFollowUp()}
                placeholder={t('taskCoding.followUpPlaceholder')}
                disabled={running}
              />
              <button className="secondary" onClick={sendFollowUp} disabled={running || !followUp.trim()}>
                {t('taskCoding.send')}
              </button>
            </div>
          )}

          {hasAnswer && !planPicker && (
            <div className="row" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <button className="secondary" onClick={handoff} disabled={running}>
                {t('taskCoding.handoffToWorkflow')}
              </button>
              <span className="status-neutral" style={{ fontSize: 12 }}>
                {t('taskCoding.handoffHint')}
              </span>
            </div>
          )}

          {planPicker && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-muted)' }}>
                {t('taskCoding.planPickerIntro')}
              </p>
              {planPicker.map((item, i) => (
                <div key={i} className="row" style={{ marginBottom: 6 }}>
                  <button className="secondary" onClick={() => handoffPlanItem(item)} style={{ textAlign: 'left' }}>
                    {i + 1}. {item.title}
                  </button>
                </div>
              ))}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="secondary" onClick={handoffWholeText}>
                  {t('taskCoding.handoffWholeText')}
                </button>
                <button className="secondary" onClick={() => setPlanPicker(null)}>
                  {t('taskCoding.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
