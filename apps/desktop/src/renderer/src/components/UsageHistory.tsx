import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { UsageCall, UsageKind, UsageRecord } from '../../../main/usage-store'

const KIND_KEYS: Record<UsageKind, string> = { compare: 'usageHistory.kindCompare', team: 'usageHistory.kindTeam', council: 'usageHistory.kindCouncil', specification: 'usageHistory.kindSpecification',
  task_graph: 'usageHistory.kindTaskGraph', change_request: 'usageHistory.kindChangeRequest', final_review: 'usageHistory.kindFinalReview', replanning: 'usageHistory.kindReplanning', coding: 'usageHistory.kindCoding', execution: 'usageHistory.kindExecution' }
const STAGE_KEYS: Record<string, string> = { independent: 'usageHistory.stageDraft', critique: 'usageHistory.stageCritique', revision: 'usageHistory.stageRevision', synthesis: 'usageHistory.stageSynthesis', implement: 'usageHistory.stageImplement', fix: 'usageHistory.stageFix', finalReview: 'usageHistory.stageFinalReview' }
const STATUS_KEYS = { running: 'usageHistory.statusRunning', completed: 'usageHistory.statusCompleted', failed: 'usageHistory.statusFailed', cancelled: 'usageHistory.statusCancelled', interrupted: 'usageHistory.statusInterrupted' }

export function reportedTotal(calls: UsageCall[], field: 'inputTokens' | 'outputTokens' | 'costUsd', t: TFunction): string {
  const measured = calls.filter(call => call[field] !== undefined)
  if (!measured.length) return t('usageHistory.notReported')
  const total = measured.reduce((sum, call) => sum + call[field]!, 0)
  return `${field === 'costUsd' ? '$' + total.toFixed(4) : total.toLocaleString('de-DE')} ${t('usageHistory.callsSuffix', { count: measured.length, calls: calls.length })}`
}

export default function UsageHistory(): React.JSX.Element {
  const { t } = useTranslation()
  const [records, setRecords] = useState<UsageRecord[]>([])
  const [projects, setProjects] = useState<{ id: string; goal: string }[]>([])
  const [projectId, setProjectId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    setBusy(true); setError('')
    void Promise.all([window.api.usage.list(projectId || undefined), window.api.projectSpec.list()]).then(([runs, specs]) => {
      if (!cancelled) { setRecords(runs); setProjects(specs) }
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : String(error)) })
      .finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [projectId, refresh])
  const calls = records.flatMap(record => record.calls)
  return <div>
    <div className="panel">
      <h2>{t('usageHistory.heading')}</h2>
      <div className="row">
        <label htmlFor="usage-project">{t('usageHistory.projectLabel')}</label>
        <select id="usage-project" value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">{t('usageHistory.allProjectsOption')}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.goal || project.id}</option>)}
        </select>
        <button onClick={() => setRefresh(value => value + 1)} disabled={busy}>{t('usageHistory.refresh')}</button>
      </div>
      <p>{t('usageHistory.intro1')}</p>
      <p>{t('usageHistory.summaryLine', {
        count: calls.length, input: reportedTotal(calls, 'inputTokens', t), output: reportedTotal(calls, 'outputTokens', t), cost: reportedTotal(calls, 'costUsd', t)
      })}</p>
      <p>{t('usageHistory.intro2')}</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!busy && !records.length && !error && <p>{t('usageHistory.noRecords')}</p>}
    </div>
    {records.map(record => <details className="panel" key={record.runId}>
      <summary>{new Date(record.startedAt).toLocaleString('de-DE')} · {t(KIND_KEYS[record.kind])} · {t(STATUS_KEYS[record.status])} · {t('usageHistory.callsCount', { count: record.calls.length })}</summary>
      <p>{projects.find(project => project.id === record.projectId)?.goal ?? record.projectId ?? t('usageHistory.freeOrder')}{record.workingDirectory ? ` · ${record.workingDirectory}` : ''}</p>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderSpacing: '12px 8px' }}>
        <thead><tr><th>{t('usageHistory.colPhase')}</th><th>{t('usageHistory.colAgentProvider')}</th><th>{t('usageHistory.colStatus')}</th><th>{t('usageHistory.colInputOutput')}</th><th>{t('usageHistory.colCosts')}</th></tr></thead>
        <tbody>{record.calls.map((call, index) => <tr key={call.callId ?? index}>
          <td>{call.stage ? (STAGE_KEYS[call.stage] ? t(STAGE_KEYS[call.stage]) : call.stage) : call.stepIndex !== undefined ? t('usageHistory.stepLabel', { step: call.stepIndex + 1 }) : t(KIND_KEYS[record.kind])}</td>
          <td>{call.providerId ? PROVIDER_LABELS[call.providerId] : call.executorId} · {call.backend === 'api' ? t('usageHistory.backendApi') : t('usageHistory.backendLocal')}</td>
          <td>{t(STATUS_KEYS[call.outcome])}</td><td>{call.inputTokens ?? t('usageHistory.notReported')} / {call.outputTokens ?? t('usageHistory.notReported')}</td>
          <td>{call.costUsd === undefined ? t('usageHistory.notReported') : `$${call.costUsd.toFixed(4)}`}</td>
        </tr>)}</tbody>
      </table></div>
    </details>)}
  </div>
}
