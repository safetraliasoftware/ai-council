import { useTranslation } from 'react-i18next'
import type { TaskAttempt, TaskBudget, TaskFailureKind } from '@ai-council/project-domain'

const FAILURE_KEYS: Record<TaskFailureKind, string> = {
  authentication: 'taskProgress.failureAuthentication', quota: 'taskProgress.failureQuota',
  process: 'taskProgress.failureProcess', budget: 'taskProgress.failureBudget', cancelled: 'taskProgress.failureCancelled',
  implementation: 'taskProgress.failureImplementation', policy: 'taskProgress.failurePolicy', storage: 'taskProgress.failureStorage'
}
const STAGE_KEYS: Record<string, string> = {
  implement: 'taskProgress.stageImplement', fix: 'taskProgress.stageFix', finalReview: 'taskProgress.stageFinalReview',
  checks: 'taskProgress.stageChecks', ready: 'taskProgress.stageReady'
}

export default function TaskProgress({ attempts, budget }: { attempts: TaskAttempt[]; budget: TaskBudget }): React.JSX.Element {
  const { t } = useTranslation()
  const latest = attempts.at(-1)
  const calls = attempts.flatMap(a => a.runtime?.calls ?? [])
  const activeMs = attempts.reduce((n, a) => n + (a.runtime?.activeMs ?? 0), 0)
  const corrections = attempts.reduce((n, a) => n + (a.runtime?.corrections ?? 0), 0)
  const openFindings = latest?.reviews.flatMap(r => r.findings) ?? []
  const suggestions = latest?.reviews.flatMap(r => r.suggestions ?? []) ?? []
  const providers = [...new Set(calls.map(call => call.executorId))]
  const stageOrFailureLabel = latest?.runtime?.failureKind ? t(FAILURE_KEYS[latest.runtime.failureKind])
    : STAGE_KEYS[latest?.runtime?.stage ?? ''] ? t(STAGE_KEYS[latest?.runtime?.stage ?? '']) : t('taskProgress.noMeasurements')
  return <div className="status-neutral">
    <p>{stageOrFailureLabel}
      {openFindings.length > 0 ? t('taskProgress.openFindingsSuffix', { count: openFindings.length }) : ''}</p>
    <p>{t('taskProgress.statsLine', {
      calls: calls.length, maxCalls: budget.maxCalls, minutes: (activeMs / 60_000).toFixed(1),
      maxMinutes: budget.maxActiveMs / 60_000, corrections, maxCorrections: budget.maxCorrections
    })}</p>
    {latest?.status === 'paused' && <p>{t('taskProgress.pausedHint')}</p>}
    {suggestions.length > 0 && <details><summary>{t('taskProgress.optionalHints')}</summary><ul>{suggestions.map((s, i) => <li key={i}>{s.message}</li>)}</ul></details>}
    <details><summary>{t('taskProgress.usageHeading')}</summary>
      <p>{t('taskProgress.usageIntro')}</p>
      <table><thead><tr><th>{t('taskProgress.colAgent')}</th><th>{t('taskProgress.colCallsErrors')}</th><th>{t('taskProgress.colRuntime')}</th><th>{t('taskProgress.colInputOutput')}</th><th>{t('taskProgress.colTokens')}</th><th>{t('taskProgress.colCosts')}</th></tr></thead>
        <tbody>{providers.map(provider => {
          const own = calls.filter(c => c.executorId === provider)
          const tokens = own.filter(c => c.inputTokens !== undefined || c.outputTokens !== undefined)
          const costs = own.filter(c => c.costUsd !== undefined)
          return <tr key={provider}><td>{provider}</td><td>{own.length} / {own.filter(c => c.outcome === 'failed').length}</td>
            <td>{t('taskProgress.minutesValue', { minutes: (own.reduce((n, c) => n + ((c.finishedAt ?? Date.now()) - c.startedAt), 0) / 60_000).toFixed(1) })}</td>
            <td>{own.reduce((n, c) => n + c.inputChars, 0)} / {own.reduce((n, c) => n + c.outputChars, 0)}</td>
            <td>{tokens.length ? t('taskProgress.tokensSummary', { total: tokens.reduce((n, c) => n + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0), count: tokens.length, calls: own.length }) : t('taskProgress.notReported')}</td>
            <td>{costs.length ? t('taskProgress.costsSummary', { amount: costs.reduce((n, c) => n + c.costUsd!, 0).toFixed(4), count: costs.length, calls: own.length }) : t('taskProgress.notReported')}</td></tr>
        })}</tbody></table>
    </details>
  </div>
}
