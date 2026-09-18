import { useState } from 'react'
import type { TaskBudget } from '@ai-council/project-domain'

export function extendedTimeBudget(budget: TaskBudget, usedMs: number): TaskBudget {
  const minutes = Math.min(240, Math.max(budget.maxActiveMs / 60_000 + 30, Math.ceil(usedMs / 60_000) + 1))
  return { ...budget, maxActiveMs: minutes * 60_000 }
}

export default function TaskBudgetEditor({ taskId, budget, usedMs, paused, disabled, onSave }: {
  taskId: string; budget: TaskBudget; usedMs: number; paused: boolean; disabled: boolean
  onSave: (budget: TaskBudget) => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState({ ...budget })
  const valid = Number.isInteger(draft.maxCalls) && draft.maxCalls >= 1 && draft.maxCalls <= 100 &&
    Number.isInteger(draft.maxCorrections) && draft.maxCorrections >= 0 && draft.maxCorrections <= 20 &&
    Number.isFinite(draft.maxActiveMs) && draft.maxActiveMs >= 60_000 && draft.maxActiveMs <= 240 * 60_000
  const extension = extendedTimeBudget(budget, usedMs)
  return <details open={paused} style={{ marginTop: 8 }}>
    <summary>Budget für {taskId} ändern</summary>
    <p>Bisher {(usedMs / 60_000).toFixed(1)} aktive Minuten verbraucht. Das neue Limit gilt insgesamt und nur für diesen Task. Arbeitsstand, Verbrauch und Prüffreigaben bleiben erhalten.</p>
    <div className="row">
      <label>Aktive Minuten <input aria-label={`Zeitlimit ${taskId}`} type="number" min={1} max={240} value={draft.maxActiveMs / 60_000}
        onChange={e => setDraft(d => ({ ...d, maxActiveMs: Number(e.target.value) * 60_000 }))} /></label>
      <label>Modellaufrufe <input aria-label={`Aufruflimit ${taskId}`} type="number" min={1} max={100} value={draft.maxCalls}
        onChange={e => setDraft(d => ({ ...d, maxCalls: Number(e.target.value) }))} /></label>
      <label>Korrekturen <input aria-label={`Korrekturlimit ${taskId}`} type="number" min={0} max={20} value={draft.maxCorrections}
        onChange={e => setDraft(d => ({ ...d, maxCorrections: Number(e.target.value) }))} /></label>
    </div>
    <button disabled={disabled || !valid} onClick={() => void onSave(draft)}>Taskbudget speichern</button>{' '}
    <button disabled={disabled || extension.maxActiveMs <= budget.maxActiveMs || extension.maxActiveMs <= usedMs}
      onClick={() => void onSave(extension)}>Zeitlimit auf {extension.maxActiveMs / 60_000} Minuten erhöhen</button>
    {paused && <p>Nach dem Speichern mit „Nach Pause fortsetzen“ weiterarbeiten.</p>}
  </details>
}
