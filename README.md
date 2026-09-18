# AI Council

Desktop-App (Windows, Electron) zum gemeinsamen Beauftragen von Claude, ChatGPT/Codex und Gemini — sowohl als API-gestützte Diskussionsteilnehmer als auch als echte, lokal angemeldete CLI-Coding-Agenten in einer vollständigen Engineering-Pipeline: Spezifikation → Council → Taskgraph → Ausführung → Freigabe.

## Download

Fertige Installer gibt es unter [Releases](https://github.com/safetraliasoftware/ai-council/releases) — entweder als Setup-Installer oder als portable `.exe`. Die App sucht beim Start automatisch nach neuen Versionen.

## Funktionen

- **Vergleichen** — mehrere Antworten auf dieselbe Frage nebeneinander.
- **Team** — mehrere Anbieter teilen sich eine Aufgabe, ein gemeinsames Ergebnis.
- **Council** — mehrstufige Diskussion (unabhängige Antworten, Kritik, Synthese) für eine durchdachte Entscheidung.
- **Coding** — ein einzelner Agent arbeitet direkt in einem gewählten Ordner.
- **Workflow** — die eigentliche Engineering-Pipeline für echte Projekte: eine freigegebene Spezifikation wird vom Council in einen Taskgraph zerlegt, jeder Task läuft isoliert in einem eigenen Git-Worktree (Implementer + Reviewer, optional Challenger), inklusive Rechte-Eskalation, Korrektur-/Zeitbudget, Integration und menschlicher Freigabe.
- **Verbrauch** — Nutzungsverlauf (Aufrufe, Dauer) über alle Läufe.

Eine ausführliche Erklärung aller Begriffe (Task-Status, Scopes, Einrichtung der einzelnen Agenten) gibt es direkt im **Hilfe**-Tab der App.

## Anbieter einrichten

Pro Anbieter (Claude, ChatGPT, Gemini) lässt sich in den Einstellungen zwischen **API** (eigener API-Key), **lokal** (installierter CLI-Agent) und **Automatisch** wählen:

| Anbieter | Lokaler Agent | Offizielle Anleitung |
|---|---|---|
| Claude | Claude Code (`claude`) | https://code.claude.com/docs/en/quickstart |
| ChatGPT | Codex (`codex`) | https://developers.openai.com/codex/cli |
| Gemini | Antigravity (`agy`) | https://antigravity.google/docs/cli/getting-started/ |

Installation und Anmeldung der CLIs laufen jeweils über die offizielle Anleitung des Anbieters — AI Council erkennt den Status automatisch, sobald die CLI verfügbar ist.

## Entwicklung

npm-Workspaces-Monorepo (`packages/*`, `apps/*`) — Installation einmal am Repo-Root:

```bash
npm install
```

| Befehl | Zweck |
|---|---|
| `npm run dev` | Electron-App im Entwicklungsmodus starten |
| `npm run typecheck` | alle Workspaces typprüfen |
| `npm test` | alle Testsuiten ausführen (dauert einige Minuten — echte Git-Worktrees/Prozesse, keine Mocks) |
| `npm run build` | Produktionsbuild der Desktop-App |
| `npm run dist --workspace=@ai-council/desktop` | Installer/portable Build lokal erzeugen (ohne Veröffentlichung) |

Details zur Architektur (Paket-Schichtung, Ausführungsmodell, Konventionen) stehen in [`CLAUDE.md`](CLAUDE.md), der aktuelle Abgleich mit der Produktvision in [`docs/vision-gap-analysis.md`](docs/vision-gap-analysis.md).

## Lizenz

© Safetralia Software. Noch keine offene Lizenz vergeben — Quellcode ist öffentlich einsehbar, aber nicht zur freien Weiterverwendung freigegeben.
