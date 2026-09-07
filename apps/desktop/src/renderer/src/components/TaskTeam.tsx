import { useEffect, useRef, useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilRunEvent } from '@ai-council/council-core'
import type { SettingsState, TeamStepDto } from '../../../main/ipc-types'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

interface StepResult {
  text: string
  done: boolean
  error?: string
}

export default function TaskTeam({ settings }: { settings: SettingsState }): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [steps, setSteps] = useState<TeamStepDto[]>([
    { provider: 'anthropic', roleInstruction: 'Erstelle einen ersten Entwurf.' },
    { provider: 'openai', roleInstruction: 'Überarbeite und verbessere den Entwurf.' }
  ])
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<StepResult[]>([])
  const currentRunId = useRef<string>('')

  useEffect(() => {
    const off = window.api.task.onEvent((e: CouncilRunEvent) => {
      if (e.kind === 'run_done') {
        if (e.runId === currentRunId.current) setRunning(false)
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
    setResults(steps.map(() => ({ text: '', done: false })))
    const { runId } = await window.api.task.runTeam({ prompt, steps })
    currentRunId.current = runId
  }

  const cancel = async (): Promise<void> => {
    if (currentRunId.current) await window.api.task.cancel(currentRunId.current)
    setRunning(false)
  }

  return (
    <div>
      <div className="panel">
        <div className="field">
          <label>Ausgangsaufgabe</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="z.B. Entwickle ein Konzept für die nächste Produktfeature-Ankündigung."
          />
        </div>

        {steps.map((step, i) => (
          <div key={i} className="team-step">
            <div className="team-step-header">
              <span className="badge">Schritt {i + 1}</span>
              <button className="link" onClick={() => removeStep(i)}>
                entfernen
              </button>
            </div>
            <div className="field">
              <label>Wer übernimmt diesen Schritt?</label>
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
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Rolle / Anweisung</label>
              <textarea
                value={step.roleInstruction}
                onChange={(e) => updateStep(i, { roleInstruction: e.target.value })}
                placeholder="z.B. Recherchiere Fakten zum Thema."
              />
            </div>
            {results[i] && (
              <div className="result-card" style={{ marginTop: 12, minHeight: 0 }}>
                <div className="result-header">
                  <span className={`provider-dot dot-${step.provider}`} />
                  {PROVIDER_LABELS[step.provider]}
                  {!results[i].done && <span className="status-neutral">läuft…</span>}
                </div>
                <div className="result-body" style={{ maxHeight: 260 }}>
                  {results[i].error ? (
                    <span className="error-text">{results[i].error}</span>
                  ) : (
                    results[i].text || <span className="status-neutral">Warte…</span>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
          <button className="secondary" onClick={addStep}>
            + Schritt hinzufügen
          </button>
          <div className="row">
            {running && (
              <button className="secondary" onClick={cancel}>
                Abbrechen
              </button>
            )}
            <button
              className="primary"
              onClick={run}
              disabled={running || !prompt.trim() || steps.length === 0}
            >
              {running ? 'Läuft…' : 'Team starten'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
