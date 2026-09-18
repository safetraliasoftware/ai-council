import { useTranslation } from 'react-i18next'
import type { CouncilCallUsage } from '@ai-council/council-core'
import { PROVIDER_LABELS } from '@ai-council/shared'

const STAGE_KEYS: Record<string, string> = {
  independent: 'councilUsage.stageDraft', critique: 'councilUsage.stageCritique',
  revision: 'councilUsage.stageRevision', synthesis: 'councilUsage.stageSynthesis'
}

export default function CouncilUsage({ calls }: { calls: CouncilCallUsage[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!calls.length) return null
  return <details className="panel">
    <summary>{t('councilUsage.summary', { count: calls.length })}</summary>
    <p>{t('councilUsage.intro')}</p>
    <table style={{ width: '100%', textAlign: 'left', borderSpacing: '12px 8px' }}><thead><tr><th>{t('councilUsage.colPhase')}</th><th>{t('councilUsage.colProvider')}</th><th>{t('councilUsage.colStatus')}</th><th>{t('councilUsage.colInputOutput')}</th><th>{t('councilUsage.colCosts')}</th></tr></thead>
      <tbody>{calls.map((call, i) => <tr key={i}>
        <td>{call.stage ? t(STAGE_KEYS[call.stage]) : call.stepIndex !== undefined ? t('councilUsage.stepLabel', { step: call.stepIndex + 1 }) : t('councilUsage.compareLabel')}</td>
        <td>{PROVIDER_LABELS[call.providerId]} ({call.backend === 'api' ? t('councilUsage.backendApi') : t('councilUsage.backendLocal')})</td>
        <td>{call.outcome === 'completed' ? t('councilUsage.outcomeCompleted') : call.outcome === 'cancelled' ? t('councilUsage.outcomeCancelled') : t('councilUsage.outcomeError')}</td>
        <td>{call.inputTokens ?? t('councilUsage.notReported')} / {call.outputTokens ?? t('councilUsage.notReported')}</td>
        <td>{call.costUsd === undefined ? t('councilUsage.notReported') : `$${call.costUsd.toFixed(4)}`}</td>
      </tr>)}</tbody>
    </table>
  </details>
}
