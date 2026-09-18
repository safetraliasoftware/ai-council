import CouncilUsage from './CouncilUsage'
import type { CouncilCallUsage } from '@ai-council/council-core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilRunEvent } from '@ai-council/council-core'
import type { AttachedArtifact, SettingsState, TeamStepDto } from '../../../main/ipc-types'
import AttachmentPicker from '../AttachmentPicker'
import CompanyTruthToggle from '../CompanyTruthToggle'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

interface StepResult {
  text: string
  done: boolean
  error?: string
  warning?: string
}

export default function TaskTeam({ settings }: { settings: SettingsState }): React.JSX.Element {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AttachedArtifact[]>([])
  const [steps, setSteps] = useState<TeamStepDto[]>([
    { provider: 'anthropic', roleInstruction: t('taskTeam.defaultStep1') },
    { provider: 'openai', roleInstruction: t('taskTeam.defaultStep2') }
  ])
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<CouncilCallUsage[]>([])
  const [results, setResults] = useState<StepResult[]>([])
  const [startError, setStartError] = useState('')
  const currentRunId = useRef<string>('')

  useEffect(() => {
    const off = window.api.task.onEvent((e: CouncilRunEvent) => {
      if (e.kind === 'run_done') {
        if (e.runId === currentRunId.current) { setRunning(false); setUsage(e.usage ?? []) }
        return
      }
      if (e.runId !== currentRunId.current || e.stepIndex === undefined) return
      const stepIndex = e.stepIndex
      const event = e.event
      setResults((r) => {
        const next = [...r]
        const current = next[stepIndex] ?? { text: '', done: false }
        switch (event.type) {
          case 'text_delta':
            next[stepIndex] = { ...current, text: current.text + event.text }
            break
          case 'done':
            next[stepIndex] = { ...current, text: event.result.text, done: true }
            break
          case 'error':
            next[stepIndex] = { ...current, done: true, error: event.error.message }
            setRunning(false)
            break
          case 'warning':
            next[stepIndex] = { ...current, warning: event.message }
            break
          case 'policy_violation':
            next[stepIndex] = { ...current, warning: event.message }
            break
          default:
            break
        }
        return next
      })
    })
    return off
  }, [])

  const addStep = (): void => {
    setSteps((s) => [...s, { provider: 'gemini', roleInstruction: '' }])
  }

  const removeStep = (index: number): void => {
    setSteps((s) => s.filter((_, i) => i !== index))
  }

  const updateStep = (index: number, patch: Partial<TeamStepDto>): void => {
    setSteps((s) => s.map((step, i) => (i === index ? { ...step, ...patch } : step)))
  }

  const run = async (): Promise<void> => {
    if (!prompt.trim() || steps.length === 0) return
    setRunning(true)
    setUsage([])
    setStartError('')
    setResults(steps.map(() => ({ text: '', done: false })))
    const { runId, error } = await window.api.task.runTeam({ prompt, steps, attachments })
    if (!runId) {
      // An empty runId means the run never started (e.g. the same provider
      // was picked for two steps) - without this, "Läuft…" was left stuck
      // forever with no explanation.
      setRunning(false)
      setStartError(t('taskTeam.startFailed'))
      return
    }
    currentRunId.current = runId
  }

  const cancel = async (): Promise<void> => {
    if (currentRunId.current) await window.api.task.cancel(currentRunId.current)
    setRunning(false)
  }

  return (
    <div>
      <CouncilUsage calls={usage} />
      <div className="panel">
        <div className="field">
          <label>{t('taskTeam.startingTaskLabel')}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t('taskTeam.startingTaskPlaceholder')}
          />
        </div>
        <div className="field">
          <AttachmentPicker attachments={attachments} onChange={setAttachments} />
          <div style={{ marginTop: 8 }}>
            <CompanyTruthToggle />
          </div>
        </div>

        {steps.map((step, i) => (
          <div key={i} className="team-step">
            <div className="team-step-header">
              <span className="badge">{t('taskTeam.stepLabel', { step: i + 1 })}</span>
              <button className="link" onClick={() => removeStep(i)}>
                {t('taskTeam.removeStep')}
              </button>
            </div>
            <div className="field">
              <label>{t('taskTeam.whoTakesStep')}</label>
              <select
                value={step.provider}
                onChange={(e) => updateStep(i, { provider: e.target.value as ProviderId })}
              >
                {ALL_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
              <label>{t('taskTeam.roleInstructionLabel')}</label>
              <textarea
                value={step.roleInstruction}
                onChange={(e) => updateStep(i, { roleInstruction: e.target.value })}
                placeholder={t('taskTeam.roleInstructionPlaceholder')}
              />
            </div>
            {results[i] && (
              <div className="result-card" style={{ marginTop: 12, minHeight: 0 }}>
                <div className="result-header">
                  <span className={`provider-dot dot-${step.provider}`} />
                  {PROVIDER_LABELS[step.provider]}
                  {!results[i].done && <span className="status-neutral">{t('taskTeam.runningShort')}</span>}
                </div>
                <div className="result-body" style={{ maxHeight: 260 }}>
                  {results[i].warning && <div className="error-text">⚠ {results[i].warning}</div>}
                  {results[i].error ? (
                    <span className="error-text">{results[i].error}</span>
                  ) : (
                    results[i].text || <span className="status-neutral">{t('taskTeam.waiting')}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
          <button className="secondary" onClick={addStep}>
            {t('taskTeam.addStep')}
          </button>
          <div className="row">
            {running && (
              <button className="secondary" onClick={cancel}>
                {t('taskTeam.cancel')}
              </button>
            )}
            <button
              className="primary"
              onClick={run}
              disabled={running || !prompt.trim() || steps.length === 0}
            >
              {running ? t('taskTeam.running') : t('taskTeam.startTeam')}
            </button>
          </div>
        </div>
        {startError && (
          <p className="error-text" style={{ marginBottom: 0, whiteSpace: 'pre-line' }}>
            {startError}
          </p>
        )}
      </div>
    </div>
  )
}
