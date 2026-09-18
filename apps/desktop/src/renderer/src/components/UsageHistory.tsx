import { useEffect, useState } from 'react'
import { PROVIDER_LABELS } from '@ai-council/shared'
import type { UsageCall, UsageKind, UsageRecord } from '../../../main/usage-store'

const KINDS: Record<UsageKind, string> = { compare: 'Vergleich', team: 'Team', council: 'Council', specification: 'Spezifikation',
  task_graph: 'Taskplanung', change_request: 'Änderungsbewertung', final_review: 'Abschlussprüfung', replanning: 'Neuplanung', coding: 'Coding', execution: 'Task-Ausführung' }
const STAGES: Record<string, string> = { independent: 'Entwurf', critique: 'Kritik', revision: 'Überarbeitung', synthesis: 'Synthese', implement: 'Implementierung', fix: 'Korrektur', finalReview: 'Review' }
const STATUS = { running: 'Läuft', completed: 'Abgeschlossen', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen', interrupted: 'Unterbrochen' }

export function reportedTotal(calls: UsageCall[], field: 'inputTokens' | 'outputTokens' | 'costUsd'): string {
  const measured = calls.filter(call => call[field] !== undefined)
  if (!measured.length) return 'Nicht gemeldet'
  const total = measured.reduce((sum, call) => sum + call[field]!, 0)
  return `${field === 'costUsd' ? '$' + total.toFixed(4) : total.toLocaleString('de-DE')} (${measured.length}/${calls.length} Aufrufe)`
}

export default function UsageHistory(): React.JSX.Element {
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
      <h2>Verbrauchsverlauf</h2>
      <div className="row">
        <label htmlFor="usage-project">Projekt</label>
        <select id="usage-project" value={projectId} onChange={event => setProjectId(event.target.value)}>
          <option value="">Alle Projekte und freie Aufträge</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.goal || project.id}</option>)}
        </select>
        <button onClick={() => setRefresh(value => value + 1)} disabled={busy}>Aktualisieren</button>
      </div>
      <p>Letzte bis zu 200 Läufe. Teilnehmer- und Agentenaufrufe können mehrere interne Modellaufrufe enthalten. Fehlende Messwerte sind unbekannt; gemeldete Kosten sind keine Aussage über Abo-Abbuchungen oder Restkontingente.</p>
      <p>{calls.length} Aufrufe · Eingabe: {reportedTotal(calls, 'inputTokens')} · Ausgabe: {reportedTotal(calls, 'outputTokens')} · Kosten: {reportedTotal(calls, 'costUsd')}</p>
      <p>Neue Council- und Coding-Messwerte werden ab dieser Version gespeichert. Ältere Task-Messwerte erscheinen, soweit sie bereits vorliegen.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      {!busy && !records.length && !error && <p>Noch keine gespeicherten Messwerte.</p>}
    </div>
    {records.map(record => <details className="panel" key={record.runId}>
      <summary>{new Date(record.startedAt).toLocaleString('de-DE')} · {KINDS[record.kind]} · {STATUS[record.status]} · {record.calls.length} Aufrufe</summary>
      <p>{projects.find(project => project.id === record.projectId)?.goal ?? record.projectId ?? 'Freier Auftrag'}{record.workingDirectory ? ` · ${record.workingDirectory}` : ''}</p>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left', borderSpacing: '12px 8px' }}>
        <thead><tr><th>Phase</th><th>Agent / Anbieter</th><th>Status</th><th>Eingabe / Ausgabe (Tokens)</th><th>Gemeldete Kosten</th></tr></thead>
        <tbody>{record.calls.map((call, index) => <tr key={call.callId ?? index}>
          <td>{call.stage ? STAGES[call.stage] ?? call.stage : call.stepIndex !== undefined ? `Schritt ${call.stepIndex + 1}` : KINDS[record.kind]}</td>
          <td>{call.providerId ? PROVIDER_LABELS[call.providerId] : call.executorId} · {call.backend === 'api' ? 'API' : 'Lokal'}</td>
          <td>{STATUS[call.outcome]}</td><td>{call.inputTokens ?? 'Nicht gemeldet'} / {call.outputTokens ?? 'Nicht gemeldet'}</td>
          <td>{call.costUsd === undefined ? 'Nicht gemeldet' : `$${call.costUsd.toFixed(4)}`}</td>
        </tr>)}</tbody>
      </table></div>
    </details>)}
  </div>
}
