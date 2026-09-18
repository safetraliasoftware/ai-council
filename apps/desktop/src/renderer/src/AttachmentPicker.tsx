import { useState } from 'react'
import type { AttachedArtifact, CodingLogEntry, HistoryListEntry, HistoryRunRecord } from '../../main/ipc-types'

/**
 * Shared between TaskParallel, TaskTeam and TaskCouncil - lets a
 * Vergleichen/Team/Council request carry a real artifact (a git diff, a
 * local file, or a past Coding/Workflow run from history) instead of only
 * a hand-typed prompt. The artifacts are plain {label, text} pairs folded
 * into the prompt string by the main process right before it reaches
 * council-core (see ipc.ts's withAttachments) - this component only
 * collects them.
 */

export interface AttachmentPickerProps {
  attachments: AttachedArtifact[]
  onChange: (attachments: AttachedArtifact[]) => void
}

const MAX_HISTORY_ARTIFACT_CHARS = 30000

function truncate(text: string): string {
  if (text.length <= MAX_HISTORY_ARTIFACT_CHARS) return text
  return text.slice(0, MAX_HISTORY_ARTIFACT_CHARS) + '\n\n[... gekürzt ...]'
}

function isText(entry: CodingLogEntry): entry is Extract<CodingLogEntry, { kind: 'text' }> {
  return entry.kind === 'text'
}

/** Turns a saved run-history record into an attachable artifact. */
function formatHistoryArtifact(record: HistoryRunRecord): AttachedArtifact {
  if (record.kind === 'coding') {
    const texts = record.logs.filter(isText).map((t) => t.text)
    const done = record.logs.find((l): l is Extract<CodingLogEntry, { kind: 'done' }> => l.kind === 'done')
    const body = texts.length > 0 ? texts.join('\n\n') : (done?.summary ?? '(keine Textantwort)')
    return {
      label: `Coding-Lauf: ${record.prompt.slice(0, 60)}`,
      text: truncate(`Aufgabe: ${record.prompt}\n\n${body}`)
    }
  }

  const latestDiff = record.diffs.fix2 ?? record.diffs.fix ?? record.diffs.implement
  const diffText = latestDiff
    ? `Geänderte Dateien: ${latestDiff.files.map((f) => `${f.path} (${f.status})`).join(', ')}\n\n${
        latestDiff.diff.trim() || '(kein Inhalt-Diff)'
      }`
    : '(kein Diff erfasst)'
  const finalReviewText = (record.stages.finalReview ?? []).filter(isText).map((t) => t.text).join('\n\n')
  const resultLine = record.finalResult.success
    ? 'Abgeschlossen'
    : `Gestoppt${record.finalResult.reason ? ': ' + record.finalResult.reason : ''}`

  return {
    label: `Workflow-Lauf: ${record.task.slice(0, 60)}`,
    text: truncate(
      [
        `Aufgabe: ${record.task}`,
        `Ergebnis: ${resultLine}`,
        `--- Diff ---\n${diffText}`,
        finalReviewText ? `--- Abschlussprüfung ---\n${finalReviewText}` : ''
      ]
        .filter(Boolean)
        .join('\n\n')
    )
  }
}

export default function AttachmentPicker({ attachments, onChange }: AttachmentPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'menu' | 'diff' | 'history'>('menu')
  const [diffDir, setDiffDir] = useState('')
  const [historyList, setHistoryList] = useState<HistoryListEntry[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; neutral?: boolean } | undefined>()

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    setMode('menu')
    setMessage(undefined)
  }

  const add = (artifact: AttachedArtifact): void => {
    onChange([...attachments, artifact])
    setOpen(false)
    setMode('menu')
  }

  const remove = (index: number): void => {
    onChange(attachments.filter((_, i) => i !== index))
  }

  const pickDiffDir = async (): Promise<void> => {
    const dir = await window.api.coding.pickDirectory()
    if (dir) setDiffDir(dir)
  }

  const captureDiff = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    const result = await window.api.artifacts.captureDiff(diffDir)
    setBusy(false)
    if (result.ok && result.artifact) add(result.artifact)
    else setMessage({ text: result.error ?? 'Diff konnte nicht erfasst werden.', neutral: result.noChanges })
  }

  const attachFile = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    const result = await window.api.artifacts.readFile()
    setBusy(false)
    if (result.ok && result.artifact) add(result.artifact)
    else if (result.error) setMessage({ text: result.error })
    // ok:false with no error means the user just canceled the file dialog.
  }

  const openHistory = async (): Promise<void> => {
    setMode('history')
    setHistoryLoading(true)
    const [coding, workflow] = await Promise.all([
      window.api.history.list('coding'),
      window.api.history.list('workflow')
    ])
    setHistoryList([...coding, ...workflow].sort((a, b) => b.startedAt - a.startedAt))
    setHistoryLoading(false)
  }

  const attachFromHistory = async (id: string): Promise<void> => {
    const record = await window.api.history.get(id)
    if (!record) return
    add(formatHistoryArtifact(record))
  }

  return (
    <div>
      {attachments.length > 0 && (
        <div className="row" style={{ flexWrap: 'wrap', marginBottom: 8 }}>
          {attachments.map((a, i) => (
            <span
              key={i}
              className="badge"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              title={a.text.slice(0, 300)}
            >
              {a.label}
              <button className="secondary" style={{ padding: '0 6px' }} onClick={() => remove(i)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <button className="secondary" onClick={toggle}>
        {open ? 'Anhang schließen' : 'Anhang hinzufügen'}
      </button>

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {mode === 'menu' && (
            <div className="row">
              <button className="secondary" onClick={() => setMode('diff')}>
                Git-Diff
              </button>
              <button className="secondary" onClick={attachFile} disabled={busy}>
                Datei
              </button>
              <button className="secondary" onClick={openHistory}>
                Aus Verlauf
              </button>
            </div>
          )}

          {mode === 'diff' && (
            <div>
              <div className="row">
                <input
                  type="text"
                  value={diffDir}
                  onChange={(e) => setDiffDir(e.target.value)}
                  placeholder="C:\Pfad\zum\Projekt"
                />
                <button className="secondary" onClick={pickDiffDir}>
                  Durchsuchen…
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={captureDiff} disabled={busy || !diffDir.trim()}>
                  {busy ? 'Lädt…' : 'Diff anhängen'}
                </button>
                <button className="secondary" onClick={() => setMode('menu')}>
                  Zurück
                </button>
              </div>
            </div>
          )}

          {mode === 'history' && (
            <div>
              {historyLoading && <span className="status-neutral">Lädt…</span>}
              {!historyLoading && historyList.length === 0 && (
                <span className="status-neutral">Kein Verlauf vorhanden.</span>
              )}
              {!historyLoading &&
                historyList.map((h) => (
                  <div
                    key={h.id}
                    className="row"
                    style={{ cursor: 'pointer', marginBottom: 4, alignItems: 'center' }}
                    onClick={() => attachFromHistory(h.id)}
                  >
                    <span style={{ fontSize: 13 }}>
                      {h.kind === 'coding' ? '🔧' : '⚙️'} {h.summary}
                    </span>
                    <span className="status-neutral" style={{ fontSize: 11 }}>
                      {new Date(h.startedAt).toLocaleString('de-DE')}
                    </span>
                  </div>
                ))}
              <button className="secondary" onClick={() => setMode('menu')} style={{ marginTop: 8 }}>
                Zurück
              </button>
            </div>
          )}

          {message &&
            (message.neutral ? (
              <p className="status-neutral">ℹ️ {message.text}</p>
            ) : (
              <p className="error-text">✕ {message.text}</p>
            ))}
        </div>
      )}
    </div>
  )
}
