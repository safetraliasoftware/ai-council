import { useEffect, useRef, useState } from 'react'
import type { CodingExecutorEvent, PermissionTier } from '@ai-council/coding'
import type { CodingDetectResult, CodingExecutorId } from '../../../main/ipc-types'
import { CODING_EXECUTOR_LABELS, PERMISSION_TIER_LABELS } from '../../../main/ipc-types'

const EXECUTORS: CodingExecutorId[] = ['claude-code-cli', 'openai-codex-cli']
const PERMISSION_TIERS: PermissionTier[] = ['read-only', 'read-write', 'full']

const STATUS_LABELS: Record<string, string> = {
  init: 'Sitzung gestartet',
  thinking_tokens: 'denkt nach…',
  api_retry: 'Verbindung wird erneut versucht…',
  plugin_install: 'Plugin wird installiert…',
  'turn.started': 'Antwort wird erstellt…',
  'thread.started': 'Sitzung gestartet',
  status: 'wird bearbeitet…',
  task_started: 'Aufgabe gestartet'
}

type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'status'; message: string; count: number }
  | { kind: 'command'; command: string; exitCode?: number }
  | { kind: 'file_change'; path: string; changeType: string }
  | { kind: 'warning'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; summary: string; sessionId?: string }

export default function TaskCoding(): React.JSX.Element {
  const [executorId, setExecutorId] = useState<CodingExecutorId>('claude-code-cli')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [permissionTier, setPermissionTier] = useState<PermissionTier>('read-only')
  const [prompt, setPrompt] = useState('')
  const [followUp, setFollowUp] = useState('')
  const [running, setRunning] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [detect, setDetect] = useState<Partial<Record<CodingExecutorId, CodingDetectResult>>>({})
  const currentTaskId = useRef<string>('')

  useEffect(() => {
    const off = window.api.coding.onEvent(({ executorId: fromExecutor, taskId, event }) => {
      if (fromExecutor !== executorId || taskId !== currentTaskId.current) return
      applyEvent(event)
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executorId])

  const applyEvent = (event: CodingExecutorEvent): void => {
    setLogs((prev) => {
      switch (event.type) {
        case 'start':
          return prev
        case 'text': {
          const last = prev[prev.length - 1]
          if (last?.kind === 'text') {
            return [...prev.slice(0, -1), { kind: 'text', text: last.text + event.text }]
          }
          return [...prev, { kind: 'text', text: event.text }]
        }
        case 'status': {
          const last = prev[prev.length - 1]
          if (last?.kind === 'status' && last.message === event.message) {
            return [...prev.slice(0, -1), { ...last, count: last.count + 1 }]
          }
          return [...prev, { kind: 'status', message: event.message, count: 1 }]
        }
        case 'command':
          return [...prev, { kind: 'command', command: event.command, exitCode: event.exitCode }]
        case 'file_change':
          return [...prev, { kind: 'file_change', path: event.path, changeType: event.changeType }]
        case 'warning':
          return [...prev, { kind: 'warning', message: event.message }]
        case 'error':
          setRunning(false)
          return [...prev, { kind: 'error', message: event.message }]
        case 'done': {
          setRunning(false)
          setSessionId(event.sessionId)
          // Fallback: if no visible text arrived while streaming (e.g. the
          // run only used tools, or text streaming didn't fire for some
          // reason), still show the final summary instead of a bare "Fertig"
          // with no explanation - this is what was missing before.
          const hasText = prev.some((e) => e.kind === 'text')
          const withFallback: LogEntry[] =
            !hasText && event.summary ? [...prev, { kind: 'text', text: event.summary }] : prev
          return [...withFallback, { kind: 'done', summary: event.summary, sessionId: event.sessionId }]
        }
        default:
          return prev
      }
    })
  }

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
    setLogs([])
    setSessionId(undefined)
    const { taskId } = await window.api.coding.startTask({
      executorId,
      prompt,
      workingDirectory,
      permissionTier
    })
    currentTaskId.current = taskId
  }

  const sendFollowUp = async (): Promise<void> => {
    if (!followUp.trim() || !sessionId) return
    setRunning(true)
    setLogs((prev) => [...prev, { kind: 'status', message: `Du: ${followUp}`, count: 1 }])
    const { taskId } = await window.api.coding.resumeSession({
      executorId,
      prompt: followUp,
      workingDirectory,
      permissionTier,
      sessionId
    })
    currentTaskId.current = taskId
    setFollowUp('')
  }

  const abort = async (): Promise<void> => {
    if (currentTaskId.current) await window.api.coding.abort(executorId, currentTaskId.current)
    setRunning(false)
  }

  const status = detect[executorId]

  return (
    <div>
      <div className="panel">
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
          Führt die echte, lokal installierte CLI aus (Claude Code bzw. OpenAI Codex) und nutzt dabei
          deine eigene Anmeldung/Abo dieses Tools – kein separater API-Key, keine zusätzliche
          Abrechnung über den Council.
        </p>

        <div className="field">
          <label>Executor</label>
          <div className="row">
            <select
              value={executorId}
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
              Verfügbarkeit prüfen
            </button>
            {status && (
              <span className={status.installed ? 'status-ok' : 'status-bad'}>
                {status.installed
                  ? `installiert (${status.version ?? '?'}) · Auth: ${status.authStatus}`
                  : 'nicht gefunden'}
              </span>
            )}
          </div>
        </div>

        <div className="field">
          <label>Arbeitsverzeichnis</label>
          <div className="row">
            <input
              type="text"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
              placeholder="C:\Pfad\zum\Projekt"
            />
            <button className="secondary" onClick={pickDirectory}>
              Durchsuchen…
            </button>
          </div>
        </div>

        <div className="field">
          <label>Rechte für diese Aufgabe</label>
          <select
            value={permissionTier}
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
          <label>Aufgabe</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="z.B. Füge einen Dark-Mode-Toggle zur Settings-Seite hinzu."
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {running && (
            <button className="secondary" onClick={abort}>
              Abbrechen
            </button>
          )}
          <button
            className="primary"
            onClick={run}
            disabled={running || !prompt.trim() || !workingDirectory.trim()}
          >
            {running ? 'Läuft…' : 'Starten'}
          </button>
        </div>
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
                placeholder="Nachfrage stellen (setzt die Sitzung fort)…"
                disabled={running}
              />
              <button className="secondary" onClick={sendFollowUp} disabled={running || !followUp.trim()}>
                Senden
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LogLine({ entry }: { entry: LogEntry }): React.JSX.Element {
  switch (entry.kind) {
    case 'text':
      return <div style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}>{entry.text}</div>
    case 'status':
      return (
        <div className="status-neutral" style={{ marginBottom: 4 }}>
          {STATUS_LABELS[entry.message] ?? entry.message}
          {entry.count > 1 && ` (${entry.count}×)`}
        </div>
      )
    case 'command':
      return (
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: 13,
            background: 'var(--bg)',
            padding: '6px 10px',
            borderRadius: 6,
            marginBottom: 6
          }}
        >
          $ {entry.command}
          {entry.exitCode !== undefined && (
            <span className={entry.exitCode === 0 ? 'status-ok' : 'status-bad'} style={{ marginLeft: 8 }}>
              exit {entry.exitCode}
            </span>
          )}
        </div>
      )
    case 'file_change':
      return (
        <div style={{ marginBottom: 4, fontSize: 13 }}>
          📄 <span style={{ fontFamily: 'monospace' }}>{entry.path}</span>{' '}
          <span className="badge">{entry.changeType}</span>
        </div>
      )
    case 'warning':
      return (
        <div className="status-bad" style={{ marginBottom: 4 }}>
          ⚠️ {entry.message}
        </div>
      )
    case 'error':
      return (
        <div className="error-text" style={{ marginBottom: 4 }}>
          ✕ {entry.message}
        </div>
      )
    case 'done':
      return (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          <span className="status-ok">Fertig</span>
          {entry.sessionId && <span className="status-neutral"> · Session: {entry.sessionId}</span>}
        </div>
      )
  }
}
