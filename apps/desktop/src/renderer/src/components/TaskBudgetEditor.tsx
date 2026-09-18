import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskBudget } from '@ai-council/project-domain'

export function extendedTimeBudget(budget: TaskBudget, usedMs: number): TaskBudget {
  const minutes = Math.min(240, Math.max(budget.maxActiveMs / 60_000 + 30, Math.ceil(usedMs / 60_000) + 1))
  return { ...budget, maxActiveMs: minutes * 60_000 }
}

export default function TaskBudgetEditor({ taskId, budget, usedMs, paused, disabled, onSave }: {
  taskId: string; budget: TaskBudget; usedMs: number; paused: boolean; disabled: boolean
  onSave: (budget: TaskBudget) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState({ ...budget })
  const valid = Number.isInteger(draft.maxCalls) && draft.maxCalls >= 1 && draft.maxCalls <= 100 &&
    Number.isInteger(draft.maxCorrections) && draft.maxCorrections >= 0 && draft.maxCorrections <= 20 &&
    Number.isFinite(draft.maxActiveMs) && draft.maxActiveMs >= 60_000 && draft.maxActiveMs <= 240 * 60_000
  const extension = extendedTimeBudget(budget, usedMs)
  return <details open={paused} style={{ marginTop: 8 }}>
    <summary>{t('taskBudgetEditor.changeBudgetFor', { taskId })}</summary>
    <p>{t('taskBudgetEditor.usedMinutesInfo', { minutes: (usedMs / 60_000).toFixed(1) })}</p>
    <div className="row">
      <label>{t('taskBudgetEditor.activeMinutesLabel')} <input aria-label={t('taskBudgetEditor.timeLimitAriaLabel', { taskId })} type="number" min={1} max={240} value={draft.maxActiveMs / 60_000}
        onChange={e => setDraft(d => ({ ...d, maxActiveMs: Number(e.target.value) * 60_000 }))} /></label>
      <label>{t('taskBudgetEditor.modelCallsLabel')} <input aria-label={t('taskBudgetEditor.callLimitAriaLabel', { taskId })} type="number" min={1} max={100} value={draft.maxCalls}
        onChange={e => setDraft(d => ({ ...d, maxCalls: Number(e.target.value) }))} /></label>
      <label>{t('taskBudgetEditor.correctionsLabel')} <input aria-label={t('taskBudgetEditor.correctionLimitAriaLabel', { taskId })} type="number" min={0} max={20} value={draft.maxCorrections}
        onChange={e => setDraft(d => ({ ...d, maxCorrections: Number(e.target.value) }))} /></label>
    </div>
    <button disabled={disabled || !valid} onClick={() => void onSave(draft)}>{t('taskBudgetEditor.saveBudget')}</button>{' '}
    <button disabled={disabled || extension.maxActiveMs <= budget.maxActiveMs || extension.maxActiveMs <= usedMs}
      onClick={() => void onSave(extension)}>{t('taskBudgetEditor.increaseTimeLimit', { minutes: extension.maxActiveMs / 60_000 })}</button>
    {paused && <p>{t('taskBudgetEditor.resumeAfterPauseHint')}</p>}
  </details>
}
