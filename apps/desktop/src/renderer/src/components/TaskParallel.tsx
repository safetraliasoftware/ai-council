import { useEffect, useRef, useState } from 'react'
import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { CouncilRunEvent } from '@ai-council/council-core'
import type { SettingsState } from '../../../main/ipc-types'

const ALL_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

interface ResultState {
  text: string
  done: boolean
  error?: string
  outputTokens?: number
}

const EMPTY_RESULTS: Record<ProviderId, ResultState> = {
  anthropic: { text: '', done: false },
  openai: { text: '', done: false },
  gemini: { text: '', done: false }
}

export default function TaskParallel({ settings }: { settings: SettingsState }): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<ProviderId[]>(ALL_PROVIDERS)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState<Record<ProviderId, ResultState>>(EMPTY_RESULTS)
  const currentRunId = useRef<string>('')

  useEffect(() => {
    const off = window.api.task.onEvent((e: CouncilRunEvent) => {
      if (e.kind === 'run_done') {
        if (e.runId === currentRunId.current) setRunning(false)
        return
      }
      if (e.runId !== currentRunId.current) return
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
          default:
            return r
        }
      })
    })
    return off
  }, [])

  const toggle = (p: ProviderId): void => {
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : [...s, p]))
  }

  const run = async (): Promise<void> => {
    if (!prompt.trim() || selected.length === 0) return
    setRunning(true)
    setResults({
      anthropic: { text: '', done: !selected.includes('anthropic') },
      openai: { text: '', done: !selected.includes('openai') },
      gemini: { text: '', done: !selected.includes('gemini') }
    })
    const { runId } = await window.api.task.runParallel({ prompt, providers: selected })
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
          <label>Aufgabe</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="z.B. Entwirf drei Social-Media-Post-Ideen für den Launch von Plaza OS."
          />
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
          </div>
          <div className="row">
            {running && (
              <button className="secondary" onClick={cancel}>
                Abbrechen
              </button>
            )}
            <button className="primary" onClick={run} disabled={running || !prompt.trim()}>
              {running ? 'Läuft…' : 'An alle senden'}
            </button>
          </div>
        </div>
      </div>

      <div className="columns">
        {selected.map((p) => {
          const r = results[p]
          return (
            <div key={p} className="result-card">
              <div className="result-header">
                <span className={`provider-dot dot-${p}`} />
                {PROVIDER_LABELS[p]}
                {!r.done && <span className="status-neutral">läuft…</span>}
                {r.outputTokens !== undefined && (
                  <span className="status-neutral" style={{ marginLeft: 'auto' }}>
                    {r.outputTokens} Tokens
                  </span>
                )}
              </div>
              <div className="result-body">
                {r.error ? (
                  <span className="error-text">{r.error}</span>
                ) : (
                  r.text || <span className="status-neutral">Warte auf Ergebnis…</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
