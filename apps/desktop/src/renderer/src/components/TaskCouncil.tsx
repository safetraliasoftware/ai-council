import CouncilUsage from './CouncilUsage'
import type { CouncilCallUsage } from '@ai-council/council-core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilRunEvent, CouncilStage } from '@ai-council/council-core'
import type { AttachedArtifact, SettingsState } from '../../../main/ipc-types'
import AttachmentPicker from '../AttachmentPicker'
import CompanyTruthToggle from '../CompanyTruthToggle'
import { createRunEventGate } from '../runEventGate'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'xai']
const STAGE_TITLE_KEYS: Record<CouncilStage, string> = {
  independent: 'taskCouncil.stageIndependent',
  critique: 'taskCouncil.stageCritique',
  revision: 'taskCouncil.stageRevision',
  synthesis: 'taskCouncil.stageSynthesis'
}

interface EntryState {
  text: string
  done: boolean
  error?: string
  label?: string
  warning?: string
}

type StageState = Partial<Record<ProviderId, EntryState>>

export default function TaskCouncil({ settings }: { settings: SettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AttachedArtifact[]>([])
  const [selected, setSelected] = useState<ProviderId[]>(ALL_PROVIDERS)
  const [chairId, setChairId] = useState<ProviderId>('anthropic')
  // Normally a council needs >=2 to have anything to critique - but when
  // only one local agent is installed, this lets a Smoke-Test run go
  // through anyway (independent round only really means anything, but at
  // least confirms the wiring end-to-end without a second participant).
  const [allowSingleParticipant, setAllowSingleParticipant] = useState(false)
  const minimumParticipants = allowSingleParticipant ? 1 : 2
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<CouncilCallUsage[]>([])
  const [stages, setStages] = useState<Record<CouncilStage, StageState>>({
    independent: {},
    critique: {},
    revision: {},
    synthesis: {}
  })
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
    }
    applyEvent.current = apply
    const off = window.api.task.onEvent((raw: CouncilRunEvent) => {
      const e = gate.take(raw)
      if (e) apply(e)
    })
    return off
  }, [gate])

  const toggle = (p: ProviderId): void => {
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))
  }

  const canRun = prompt.trim() && selected.length >= minimumParticipants && selected.includes(chairId)

  const run = async (): Promise<void> => {
    if (!canRun) return
    setRunning(true)
    setUsage([])
    setStartError('')
    setStages({ independent: {}, critique: {}, revision: {}, synthesis: {} })
    gate.begin()
    const { runId, error } = await window.api.task.runCouncil({
      prompt,
      providers: selected,
      chairId,
      attachments
    })
    if (!runId) {
      gate.fail()
      setRunning(false)
      setStartError(error ?? t('taskCouncil.startFailed'))
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
          <label>{t('taskCouncil.taskLabel')}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('taskCouncil.taskPlaceholder')}
          />
        </div>
        <div className="field">
          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
        </div>
        <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
              <input
                type="checkbox"
                checked={allowSingleParticipant}
                onChange={(e) => setAllowSingleParticipant(e.target.checked)}
                style={{ width: 'auto' }}
              />
              {t('taskCouncil.allowSingleParticipant')}
            </label>
          </div>
          <div className="row">
            <label style={{ margin: 0 }}>{t('taskCouncil.chairLabel')}</label>
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
                {t('taskCouncil.cancel')}
              </button>
            )}
            <button className="primary" onClick={run} disabled={running || !canRun}>
              {running ? t('taskCouncil.running') : t('taskCouncil.convene')}
            </button>
          </div>
        </div>
        {selected.length < minimumParticipants && (
          <p className="status-neutral" style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
            {allowSingleParticipant
              ? t('taskCouncil.minOneProvider')
              : t('taskCouncil.minTwoProviders')}
          </p>
        )}
        {startError && (
          <p className="error-text" style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
            {startError}
          </p>
        )}
      </div>

      {(Object.keys(stages) as CouncilStage[]).map((stage) => {
        const entries = Object.entries(stages[stage]) as [ProviderId, EntryState][]
        if (entries.length === 0) return null
        return (
          <div key={stage} style={{ marginTop: 20 }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 14, color: 'var(--text-muted)' }}>
              {t(STAGE_TITLE_KEYS[stage])}
            </h3>
            <div className="columns">
              {entries.map(([providerId, entry]) => (
                <div key={providerId} className="result-card">
                  <div className="result-header">
                    <span className={`provider-dot dot-${providerId}`} />
                    {PROVIDER_LABELS[providerId]}
                    {entry.label && (
                      <span className="badge" style={{ marginLeft: 6 }}>
                        {entry.label}
                      </span>
                    )}
                    {!entry.done && <span className="status-neutral">{t('taskCouncil.runningShort')}</span>}
                  </div>
                  <div className="result-body">
                    {entry.warning && <div className="error-text">⚠ {entry.warning}</div>}
                    {entry.error ? (
                      <>
                        <div className="error-text">⚠ {t('taskCouncil.participantFailed', { error: entry.error })}</div>
                        <div className="status-neutral" style={{ fontSize: 12, marginTop: 4 }}>
                          {t('taskCouncil.othersContinue')}
                        </div>
                      </>
                    ) : (
                      entry.text || <span className="status-neutral">{t('taskCouncil.waiting')}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
