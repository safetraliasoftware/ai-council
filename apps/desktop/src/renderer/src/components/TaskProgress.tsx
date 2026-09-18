import type { TaskAttempt, TaskBudget, TaskFailureKind } from '@ai-council/project-domain'

const FAILURES: Record<TaskFailureKind, string> = {
  authentication: 'Anmeldung beim Anbieter erforderlich', quota: 'Nutzungslimit erreicht – später oder mit anderem Agenten fortsetzen',
  process: 'Agent technisch unterbrochen', budget: 'Taskbudget ausgeschöpft', cancelled: 'Von dir angehalten',
  implementation: 'Fachliche Korrektur erforderlich', policy: 'Unerlaubte Änderung erkannt', storage: 'Speicherfehler'
}
const STAGES: Record<string, string> = { implement: 'Implementierung', fix: 'Korrektur', finalReview: 'Unabhängige Prüfung', checks: 'Build und Tests', ready: 'Bereit zur Integration' }

export default function TaskProgress({ attempts, budget }: { attempts: TaskAttempt[]; budget: TaskBudget }): React.JSX.Element {
  const latest = attempts.at(-1)
  const calls = attempts.flatMap(a => a.runtime?.calls ?? [])
  const activeMs = attempts.reduce((n, a) => n + (a.runtime?.activeMs ?? 0), 0)
  const corrections = attempts.reduce((n, a) => n + (a.runtime?.corrections ?? 0), 0)
  const openFindings = latest?.reviews.flatMap(r => r.findings) ?? []
  const suggestions = latest?.reviews.flatMap(r => r.suggestions ?? []) ?? []
  const providers = [...new Set(calls.map(call => call.executorId))]
  return <div className="status-neutral">
    <p>{latest?.runtime?.failureKind ? FAILURES[latest.runtime.failureKind] : STAGES[latest?.runtime?.stage ?? ''] ?? 'Noch keine Messwerte'}
      {openFindings.length > 0 ? ` · ${openFindings.length} offene Review-Befunde` : ''}</p>
    <p>{calls.length}/{budget.maxCalls} Agentenaufrufe · {(activeMs / 60_000).toFixed(1)}/{budget.maxActiveMs / 60_000} aktive Minuten · {corrections}/{budget.maxCorrections} Korrekturen</p>
    {latest?.status === 'paused' && <p>Arbeitsstand erhalten. Ursache beheben und fortsetzen; das startet keine neue Implementierung von vorn.</p>}
    {suggestions.length > 0 && <details><summary>Optionale Hinweise – blockieren nicht</summary><ul>{suggestions.map((s, i) => <li key={i}>{s.message}</li>)}</ul></details>}
    <details><summary>Verbrauch und Laufzeiten</summary>
      <p>Messwerte ab dieser Programmversion. Aktive Zeit umfasst Agenten und Prüfungen, ohne Wartezeit auf deine Freigaben. Token- und Kostenangaben erscheinen nur, wenn der Agent sie meldet.</p>
      <table><thead><tr><th>Agent</th><th>Aufrufe / Fehler</th><th>Laufzeit</th><th>Eingabe / Ausgabe (Zeichen)</th><th>Gemeldete Tokens</th><th>Gemeldete Kosten</th></tr></thead>
        <tbody>{providers.map(provider => {
          const own = calls.filter(c => c.executorId === provider)
          const tokens = own.filter(c => c.inputTokens !== undefined || c.outputTokens !== undefined)
          const costs = own.filter(c => c.costUsd !== undefined)
          return <tr key={provider}><td>{provider}</td><td>{own.length} / {own.filter(c => c.outcome === 'failed').length}</td>
            <td>{(own.reduce((n, c) => n + ((c.finishedAt ?? Date.now()) - c.startedAt), 0) / 60_000).toFixed(1)} min</td>
            <td>{own.reduce((n, c) => n + c.inputChars, 0)} / {own.reduce((n, c) => n + c.outputChars, 0)}</td>
            <td>{tokens.length ? `${tokens.reduce((n, c) => n + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0)} (${tokens.length}/${own.length} Aufrufe)` : 'Nicht gemeldet'}</td>
            <td>{costs.length ? `$${costs.reduce((n, c) => n + c.costUsd!, 0).toFixed(4)} (${costs.length}/${own.length} Aufrufe)` : 'Nicht gemeldet'}</td></tr>
        })}</tbody></table>
    </details>
  </div>
}
