import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { MAX_FILE_ATTACHMENTS, type AttachedArtifact, type CodingLogEntry, type HistoryListEntry, type HistoryRunRecord } from '../../main/ipc-types'

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

function truncate(text: string, t: TFunction): string {
  if (text.length <= MAX_HISTORY_ARTIFACT_CHARS) return text
  return text.slice(0, MAX_HISTORY_ARTIFACT_CHARS) + '\n\n' + t('attachmentPicker.truncated')
}

function isText(entry: CodingLogEntry): entry is Extract<CodingLogEntry, { kind: 'text' }> {
  return entry.kind === 'text'
}

function fileChipLabel(artifact: AttachedArtifact, t: TFunction): string {
  const name = artifact.filename ?? artifact.label
  if (artifact.mimeType === 'application/pdf') return t('attachmentPicker.pdfChip', { name })
  if (artifact.mimeType?.startsWith('image/')) return t('attachmentPicker.imageChip', { name })
  return name
}

/** Turns a saved run-history record into an attachable artifact. */
function formatHistoryArtifact(record: HistoryRunRecord, t: TFunction): AttachedArtifact {
  if (record.kind === 'coding') {
    const texts = record.logs.filter(isText).map((entry) => entry.text)
    const done = record.logs.find((l): l is Extract<CodingLogEntry, { kind: 'done' }> => l.kind === 'done')
    const body = texts.length > 0 ? texts.join('\n\n') : (done?.summary ?? t('attachmentPicker.noTextResponse'))
    return {
      kind: 'inline-text',
      label: t('attachmentPicker.codingRunLabel', { prompt: record.prompt.slice(0, 60) }),
      text: truncate(`${t('attachmentPicker.taskLine', { task: record.prompt })}\n\n${body}`, t)
    }
  }

  const latestDiff = record.diffs.fix2 ?? record.diffs.fix ?? record.diffs.implement
  const diffText = latestDiff
    ? `${t('attachmentPicker.changedFiles', { files: latestDiff.files.map((f) => `${f.path} (${f.status})`).join(', ') })}\n\n${
        latestDiff.diff.trim() || t('attachmentPicker.noDiffContent')
      }`
    : t('attachmentPicker.noDiffCaptured')
  const finalReviewText = (record.stages.finalReview ?? []).filter(isText).map((entry) => entry.text).join('\n\n')
  const resultLine = record.finalResult.success
    ? t('attachmentPicker.resultCompleted')
    : t('attachmentPicker.resultStopped', { reason: record.finalResult.reason ? `: ${record.finalResult.reason}` : '' })

  return {
    kind: 'inline-text',
    label: t('attachmentPicker.workflowRunLabel', { task: record.task.slice(0, 60) }),
    text: truncate(
      [
        t('attachmentPicker.taskLine', { task: record.task }),
        t('attachmentPicker.resultLine', { result: resultLine }),
        t('attachmentPicker.diffSection', { diff: diffText }),
        finalReviewText ? t('attachmentPicker.finalReviewSection', { review: finalReviewText }) : ''
      ]
        .filter(Boolean)
        .join('\n\n'),
      t
    )
  }
}

export default function AttachmentPicker({ attachments, onChange }: AttachmentPickerProps): React.JSX.Element {
  const { t } = useTranslation()
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
    else setMessage({ text: result.error ?? t('attachmentPicker.diffCaptureFailed'), neutral: result.noChanges })
  }

  const attachFile = async (): Promise<void> => {
    const fileCount = attachments.filter((a) => a.kind === 'file').length
    if (fileCount >= MAX_FILE_ATTACHMENTS) {
      setMessage({ text: t('attachmentPicker.tooManyFiles', { max: MAX_FILE_ATTACHMENTS }) })
      return
    }
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
    add(formatHistoryArtifact(record, t))
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
              title={a.kind === 'file' ? (a.filename ?? a.label) : (a.text ?? a.label).slice(0, 300)}
            >
              {a.kind === 'file' ? fileChipLabel(a, t) : a.label}
              <button className="secondary" style={{ padding: '0 6px' }} onClick={() => remove(i)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <button className="secondary" onClick={toggle}>
        {open ? t('attachmentPicker.closeAttachment') : t('attachmentPicker.addAttachment')}
      </button>

      {open && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
          {mode === 'menu' && (
            <div className="row">
              <button className="secondary" onClick={() => setMode('diff')}>
                {t('attachmentPicker.gitDiff')}
              </button>
              <button className="secondary" onClick={attachFile} disabled={busy}>
                {t('attachmentPicker.file')}
              </button>
              <button className="secondary" onClick={openHistory}>
                {t('attachmentPicker.fromHistory')}
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
                  placeholder={t('attachmentPicker.pathPlaceholder')}
                />
                <button className="secondary" onClick={pickDiffDir}>
                  {t('attachmentPicker.browse')}
                </button>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={captureDiff} disabled={busy || !diffDir.trim()}>
                  {busy ? t('attachmentPicker.loading') : t('attachmentPicker.attachDiff')}
                </button>
                <button className="secondary" onClick={() => setMode('menu')}>
                  {t('attachmentPicker.back')}
                </button>
              </div>
            </div>
          )}

          {mode === 'history' && (
            <div>
              {historyLoading && <span className="status-neutral">{t('attachmentPicker.loading')}</span>}
              {!historyLoading && historyList.length === 0 && (
                <span className="status-neutral">{t('attachmentPicker.noHistory')}</span>
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
                {t('attachmentPicker.back')}
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
