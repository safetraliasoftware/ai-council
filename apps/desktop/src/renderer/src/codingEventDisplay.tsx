import type { CodingExecutorEvent } from '@ai-council/coding'
import type { CodingLogEntry } from '../../main/ipc-types'

/** Shared between TaskCoding and TaskWorkflow - same event vocabulary, same display rules. */

export const STATUS_LABELS: Record<string, string> = {
  init: 'Sitzung gestartet',
  thinking_tokens: 'denkt nach…',
  api_retry: 'Verbindung wird erneut versucht…',
  plugin_install: 'Plugin wird installiert…',
  'turn.started': 'Antwort wird erstellt…',
  'thread.started': 'Sitzung gestartet',
  status: 'wird bearbeitet…',
  task_started: 'Aufgabe gestartet'
}

// LogEntry lives in ipc-types.ts (the shared main/preload/renderer boundary)
// so the main-process history store can persist and return it without
// importing renderer code.
export type LogEntry = CodingLogEntry

/**
 * Pure reducer: given the log so far and one new CodingExecutorEvent,
 * returns the updated log. No side effects (no setState calls for
 * "running"/"sessionId" etc.) - callers inspect `event.type` themselves for
 * that, since what counts as "this stage is done" differs between a
 * standalone task (TaskCoding) and one stage of a workflow (TaskWorkflow).
 */
export function applyCodingEvent(prev: LogEntry[], event: CodingExecutorEvent): LogEntry[] {
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
      return [...prev, { kind: 'error', message: event.message }]
    case 'done': {
      // Fallback: if no visible text arrived while streaming, still show the
      // final summary instead of a bare "Fertig" with no explanation.
      const hasText = prev.some((e) => e.kind === 'text')
      const withFallback: LogEntry[] =
        !hasText && event.summary ? [...prev, { kind: 'text', text: event.summary }] : prev
      return [...withFallback, { kind: 'done', summary: event.summary, sessionId: event.sessionId }]
    }
    default:
      return prev
  }
}

export function LogLine({ entry }: { entry: LogEntry }): React.JSX.Element {
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
