import type { CouncilCallUsage } from '@ai-council/council-core'
import { PROVIDER_LABELS } from '@ai-council/shared'

const STAGES: Record<string, string> = { independent: 'Entwurf', critique: 'Kritik', revision: 'Überarbeitung', synthesis: 'Synthese' }

export default function CouncilUsage({ calls }: { calls: CouncilCallUsage[] }): React.JSX.Element | null {
  if (!calls.length) return null
  return <details className="panel">
    <summary>Verbrauch: {calls.length} Teilnehmeraufrufe</summary>
    <p>Ein Teilnehmeraufruf kann mehrere interne Modellaufrufe enthalten. Angezeigt werden nur gemeldete Tokenwerte und Kosten; daraus lässt sich kein verbleibendes Abo-Kontingent ableiten.</p>
    <table style={{ width: '100%', textAlign: 'left', borderSpacing: '12px 8px' }}><thead><tr><th>Phase</th><th>Anbieter</th><th>Status</th><th>Eingabe / Ausgabe (Tokens)</th><th>Gemeldete Kosten</th></tr></thead>
      <tbody>{calls.map((call, i) => <tr key={i}>
        <td>{call.stage ? STAGES[call.stage] : call.stepIndex !== undefined ? `Schritt ${call.stepIndex + 1}` : 'Vergleich'}</td>
        <td>{PROVIDER_LABELS[call.providerId]} ({call.backend === 'api' ? 'API' : 'Lokal'})</td>
        <td>{call.outcome === 'completed' ? 'Fertig' : call.outcome === 'cancelled' ? 'Abgebrochen' : 'Fehler'}</td>
        <td>{call.inputTokens ?? 'Nicht gemeldet'} / {call.outputTokens ?? 'Nicht gemeldet'}</td>
        <td>{call.costUsd === undefined ? 'Nicht gemeldet' : `$${call.costUsd.toFixed(4)}`}</td>
      </tr>)}</tbody>
    </table>
  </details>
}
