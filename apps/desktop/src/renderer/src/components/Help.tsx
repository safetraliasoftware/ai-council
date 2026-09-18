import type { ProviderId } from '@ai-council/shared'
import { PROVIDER_LABELS } from '@ai-council/shared'
import { LOCAL_AGENT_DOCS, LOCAL_AGENT_LABEL } from './Settings'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini']

export default function Help(): React.JSX.Element {
  return (
    <div className="panel" style={{ maxWidth: 800 }}>
      <h3 style={{ marginTop: 0 }}>Überblick: Was macht welcher Tab?</h3>
      <ul style={{ color: 'var(--text-muted)' }}>
        <li><strong>Vergleichen</strong> - stellt mehrere Antworten auf dieselbe Frage nebeneinander.</li>
        <li><strong>Team</strong> - mehrere Anbieter teilen sich eine Aufgabe, ein gemeinsames Ergebnis.</li>
        <li><strong>Council</strong> - mehrstufige Diskussion (unabhängige Antworten, Kritik, Synthese) für eine durchdachte Entscheidung.</li>
        <li><strong>Coding</strong> - ein einzelner Agent arbeitet direkt in einem von dir gewählten Ordner.</li>
        <li><strong>Workflow</strong> - die große Pipeline für echte Projekte: Spezifikation → Council → Taskgraph → Ausführung → Freigabe. Siehe unten für Details.</li>
        <li><strong>Verbrauch</strong> - Nutzungsverlauf (Aufrufe/Dauer) über alle Läufe.</li>
        <li><strong>Einstellungen</strong> - API-Keys, lokale Agenten, Backend-Wahl, Werkstatt-Ordner.</li>
      </ul>

      <h3 style={{ marginTop: 32 }}>Einen Anbieter einrichten - API oder lokal</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        In den Einstellungen wählst du pro Anbieter zwischen drei Optionen: <strong>API</strong> (dein
        eigener API-Key, Kosten pro Nutzung), <strong>lokal</strong> (der jeweils installierte CLI-Agent,
        meist im Abo bereits enthalten) oder <strong>Automatisch</strong> (nutzt den lokalen Agenten, falls
        verfügbar; weicht nur auf die kostenpflichtige API aus, wenn du das per Häkchen ausdrücklich
        erlaubt hast).
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        Für einen API-Key gibt es keine Format-Prüfung - füge ihn einfach ein und klicke auf
        <strong> „testen"</strong>, das ist die einzige echte Verifikation.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        Bei den lokalen Agenten zeigt die App den erkannten Anmeldestatus an. Bei Claude Code ist das eine
        echte Prüfung (angemeldet ja/nein). Bei Codex und Antigravity zeigt die Anmeldung immer
        <strong> „unknown"</strong> an, sobald die CLI gefunden wurde - das ist normal und kein Fehler:
        beide CLIs bieten (Stand jetzt) keine Möglichkeit, den Anmeldestatus ohne echten Lauf abzufragen.
      </p>
      {PROVIDERS.map((provider) => {
        const info = LOCAL_AGENT_DOCS[provider]
        return (
          <div key={provider} className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <div>
              <span className={`provider-dot dot-${provider}`} />
              {PROVIDER_LABELS[provider]} - {LOCAL_AGENT_LABEL[provider]}{' '}
              <span className="status-neutral">({info.binary})</span>
            </div>
            <a href={info.docsUrl} target="_blank" rel="noreferrer">Offizielle Anleitung</a>
          </div>
        )
      })}

      <h3 style={{ marginTop: 32 }}>Der Workflow-Tab im Detail</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Bevor irgendetwas ausgeführt wird, muss eine Spezifikation freigegeben werden. Ein vom Council
        erstellter Taskgraph zerlegt das Ziel in einzelne Tasks. Jeder Task läuft in einem eigenen,
        isolierten Arbeitsbereich (eigener Git-Worktree) - Implementer und Reviewer (optional auch ein
        Challenger) prüfen unabhängig voneinander, bevor etwas ins Projekt übernommen wird.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        Status, die dabei auftauchen können:
      </p>
      <ul style={{ color: 'var(--text-muted)' }}>
        <li><strong>running</strong> - der Task wird gerade bearbeitet.</li>
        <li><strong>awaiting_permission</strong> - der Agent bittet um weitergehenden Zugriff (z.B. Shell-Befehle). Das ist normal, keine Störung - einmal bestätigen und es geht weiter.</li>
        <li><strong>awaiting_install</strong> - ein benötigtes Werkzeug fehlt; die App schlägt einen Installationsbefehl vor, den du prüfen und bestätigen kannst.</li>
        <li><strong>review</strong> - Prüfungen und Reviews sind erfolgreich durch, wartet auf deine Freigabe.</li>
        <li><strong>paused</strong> - z.B. weil ein Sitzungslimit eines Agenten erreicht wurde. Nichts geht verloren - später am selben Punkt fortsetzbar.</li>
        <li><strong>failed</strong> - Prüfungen oder Review sind nicht durchgekommen; ein neuer Versuch kann gestartet werden.</li>
        <li><strong>escalated</strong> - eine echte Entscheidung von dir ist nötig (z.B. eine Änderung am erlaubten Bereich), bevor es weitergeht.</li>
      </ul>
      <p style={{ color: 'var(--text-muted)' }}>
        Jeder Task hat außerdem ein Korrektur- und Zeitbudget (wie viele Korrekturrunden bzw. wie lange er
        aktiv laufen darf) - falls ein Task mehr braucht, lässt sich das Budget gezielt anpassen.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Braucht mein Projektordner schon ein Git-Repository?</strong> Nein, das übernimmt der
        Workflow-Tab automatisch - gilt für alle drei Agenten gleich, ist keine Codex-Besonderheit. Ein
        leerer Ordner wird beim ersten Mal automatisch initialisiert. Ein bereits bestehender Ordner mit
        Git-Historie wird einfach weiterverwendet. Ein bestehender Ordner <strong>mit Dateien, aber ohne
        bisherigen Git-Commit</strong> (z.B. ein vorhandenes Projekt, das noch nie in Git war) wird dagegen
        abgelehnt - dort muss einmal <code>git init</code> und ein erster Commit von Hand gemacht werden,
        bevor der Ordner hier ausgewählt wird. Der Coding-Tab braucht dagegen gar kein Git.
      </p>

      <h3 style={{ marginTop: 32 }}>Verbrauch verstehen</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Der Verbrauch-Tab zeigt, was diese App selbst gemessen hat: Aufrufe und Dauer je Lauf. Das ist
        <strong> nicht</strong> das exakte Restkontingent eines Abos - dafür gibt es keine verlässliche
        Quelle, die App zeigt nur die eigene, tatsächlich gemessene Nutzung.
      </p>

      <h3 style={{ marginTop: 32 }}>Kurz-FAQ</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Ich habe eine CLI gerade installiert, die App zeigt trotzdem „nicht installiert".</strong><br />
        Einstellungen einmal neu öffnen bzw. die App neu starten - der Systempfad (PATH) wird sonst nicht
        neu eingelesen.
      </p>
      <p style={{ color: 'var(--text-muted)' }}>
        <strong>Was ist der „erlaubte Bereich" (Scope) eines Tasks?</strong><br />
        Nur die dort gelisteten Dateien/Ordner darf ein Task ändern - das schützt den Rest des Projekts vor
        ungewollten Änderungen.
      </p>

      <h3 style={{ marginTop: 32 }}>Support</h3>
      <p style={{ color: 'var(--text-muted)' }}>
        Frage oder Problem? Schreib mir direkt.
      </p>
      <button
        className="secondary"
        onClick={() => { window.location.href = 'mailto:info@safetralia.de?subject=AI%20Council%20Support' }}
      >
        Support kontaktieren
      </button>
    </div>
  )
}
