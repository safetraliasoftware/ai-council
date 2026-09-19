import CouncilUsage from './CouncilUsage'
import type { CouncilCallUsage } from '@ai-council/council-core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilRunEvent } from '@ai-council/council-core'
import type { AttachedArtifact, SettingsState } from '../../../main/ipc-types'
import AttachmentPicker from '../AttachmentPicker'
import CompanyTruthToggle from '../CompanyTruthToggle'
import { createRunEventGate } from '../runEventGate'

import { ALL_PROVIDERS, useReadyProviderSelection } from '../provider-ready'

interface ResultState {
  text: string
  done: boolean
  error?: string
  outputTokens?: number
  warning?: string
}

const EMPTY_RESULTS: Record<ProviderId, ResultState> = {
  anthropic: { text: '', done: false },
  openai: { text: '', done: false },
  gemini: { text: '', done: false },
  xai: { text: '', done: false }
}

export default function TaskParallel({ settings }: { settings: SettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AttachedArtifact[]>([])
  const [selected, toggle] = useReadyProviderSelection(settings)
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<CouncilCallUsage[]>([])
  const [results, setResults] = useState<Record<ProviderId, ResultState>>(EMPTY_RESULTS)
  const [startError, setStartError] = useState('')
  const gate = useRef(createRunEventGate()).current
  const applyEvent = useRef<(e: CouncilRunEvent) => void>(() => {})

  useEffect(() => {
    const apply = (e: CouncilRunEvent): void => {
      if (e.kind === 'run_done') {
        setRunning(false)
        setUsage(e.usage ?? [])
        return
      }
      const { providerId, event } = e
      setResults((r) => {
        const current = r[providerId]
        switch (event.type) {
          case 'text_delta':
            return { ...r, [providerId]: { ...current, text: current.text + event.text } }
          case 'done':
            return { ...r, [providerId]: { ...current, text: event.result.text, done: true } }
          case 'usage':
            return { ...r, [providerId]: { ...current, outputTokens: event.usage.outputTokens } }
          case 'error':
            return { ...r, [providerId]: { ...current, done: true, error: event.error.message } }
          case 'warning':
            return { ...r, [providerId]: { ...current, warning: event.message } }
          case 'policy_violation':
            return { ...r, [providerId]: { ...current, warning: event.message } }
          default:
            return r
        }
      })
    }
    applyEvent.current = apply
    const off = window.api.task.onEvent((raw: CouncilRunEvent) => {
      const e = gate.take(raw)
      if (e) apply(e)
    })
    return off
  }, [gate])

  const run = async (): Promise<void> => {
    if (!prompt.trim() || selected.length === 0) return
    setRunning(true)
    setUsage([])
    setStartError('')
    setResults({
      anthropic: { text: '', done: !selected.includes('anthropic') },
      openai: { text: '', done: !selected.includes('openai') },
      gemini: { text: '', done: !selected.includes('gemini') },
      xai: { text: '', done: !selected.includes('xai') }
    })
    gate.begin()
    const { runId, error } = await window.api.task.runParallel({
      prompt,
      providers: selected,
      attachments
    })
    if (!runId) {
      gate.fail()
      setRunning(false)
      setStartError(error ?? t('taskParallel.startFailed'))
      return
    }
    for (const e of gate.commit(runId)) applyEvent.current(e)
  }

  const cancel = async (): Promise<void> => {
    if (gate.id) await window.api.task.cancel(gate.id)
    setRunning(false)
  }

  return (
    <div>
      <CouncilUsage calls={usage} />
      <div className="panel">
        <div className="field">
          <label>{t('taskParallel.taskLabel')}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('taskParallel.taskPlaceholder')}
          />
        </div>
        <div className="field">
          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row">
            {ALL_PROVIDERS.map((p) => (
              <label key={p} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(p)}
                  onChange={() => toggle(p)}
                  style={{ width: 'auto' }}
                />
                {PROVIDER_LABELS[p]}
              </label>
            ))}
            <CompanyTruthToggle />
          </div>
          <div className="row">
            {running && (
              <button className="secondary" onClick={cancel}>
                {t('taskParallel.cancel')}
              </button>
            )}
            <button className="primary" onClick={run} disabled={running || !prompt.trim()}>
              {running ? t('taskParallel.running') : t('taskParallel.sendToAll')}
            </button>
          </div>
        </div>
        {startError && (
          <p className="error-text" style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
            {startError}
          </p>
        )}
      </div>

      <div className="columns">
        {selected.map((p) => {
          const r = results[p]
          return (
            <div key={p} className="result-card">
              <div className="result-header">
                <span className={`provider-dot dot-${p}`} />
                {PROVIDER_LABELS[p]}
                {!r.done && <span className="status-neutral">{t('taskParallel.runningShort')}</span>}
                {r.outputTokens !== undefined && (
                  <span className="status-neutral" style={{ marginLeft: 'auto' }}>
                    {t('taskParallel.tokensSuffix', { count: r.outputTokens })}
                  </span>
                )}
              </div>
              <div className="result-body">
                {r.warning && <div className="error-text">⚠ {r.warning}</div>}
                {r.error ? (
                  <span className="error-text">{r.error}</span>
                ) : (
                  r.text || <span className="status-neutral">{t('taskParallel.waitingForResult')}</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
