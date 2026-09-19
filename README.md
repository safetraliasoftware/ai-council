# AI Council

Windows-Desktop-App zum gemeinsamen Beauftragen von **Claude**, **ChatGPT/Codex**, **Gemini** und **Grok** — als API-Teilnehmer und als lokal angemeldete CLI-Coding-Agenten.

Aktuelle Version: **[0.1.3](https://github.com/safetraliasoftware/ai-council/releases/tag/v0.1.3)** · Oberfläche auf Deutsch, English, Français und Español · [Wiki](https://github.com/safetraliasoftware/ai-council/wiki)

## Download

Unter [Releases](https://github.com/safetraliasoftware/ai-council/releases/latest):

| Datei | Zweck |
|---|---|
| `AI-Council-Setup-0.1.3.exe` | Installer (Ordner wählbar) |
| `AI-Council-0.1.3.exe` | Portable, ohne Installation |

Die App prüft beim Start automatisch auf neue Versionen und fragt vor der Installation nach. Windows 10 oder neuer.

## Was die App kann

| Tab | Zweck |
|---|---|
| **Vergleichen** | Mehrere Antworten auf dieselbe Frage nebeneinander. |
| **Team** | Mehrere Anbieter teilen sich eine Aufgabe in Schritten, ein gemeinsames Ergebnis. |
| **Council** | Mehrstufige Diskussion: unabhängige Antworten, anonymisierte Kritik, Überarbeitung, Synthese. |
| **Coding** | Ein einzelner lokal angemeldeter Agent arbeitet direkt in einem Ordner. |
| **Workflow** | Engineering-Pipeline: Spezifikation → Council → Taskgraph → isolierte Ausführung → Freigabe. |
| **Verbrauch** | Gemessene Aufrufe, Dauer und gemeldete Tokens/Kosten — kein Abo-Restkontingent. |

Ausführliche Anleitungen stehen im **[Wiki](https://github.com/safetraliasoftware/ai-council/wiki)** und im Hilfe-Tab der App.

## Anbieter einrichten

Beim ersten Start führt die App durch die Einrichtung. Pro Anbieter lässt sich **API** (eigener Key), **lokal** (installierter CLI-Agent) oder **Automatisch** wählen.

| Anbieter | Lokaler Agent | Offizielle Anleitung |
|---|---|---|
| Claude | Claude Code (`claude`) | https://code.claude.com/docs/en/quickstart |
| ChatGPT | Codex (`codex`) | https://developers.openai.com/codex/cli |
| Gemini | Antigravity (`agy`) | https://antigravity.google/docs/cli/getting-started/ |
| Grok | Grok Build (`grok`) | https://docs.x.ai/build/overview |

API-Keys bleiben verschlüsselt auf diesem Rechner (`safeStorage`) und verlassen den Hauptprozess nicht. Installation und Anmeldung der CLIs folgen der jeweiligen Herstelleranleitung — AI Council erkennt den Status, sobald die CLI verfügbar ist.

## Entwicklung

npm-Workspaces-Monorepo (`packages/*`, `apps/*`) — Installation einmal am Repo-Root:

```bash
npm install
```

| Befehl | Zweck |
|---|---|
| `npm run dev` | Electron-App im Entwicklungsmodus |
| `npm run typecheck` | alle Workspaces typprüfen |
| `npm test` | alle Testsuiten (einige Minuten, echte Git-Worktrees/Prozesse) |
| `npm run build` | Produktionsbuild der Desktop-App |
| `npm run dist --workspace=@ai-council/desktop` | Installer/portable lokal erzeugen (ohne Veröffentlichung) |

Architektur und Konventionen: [`CLAUDE.md`](CLAUDE.md) · Entwicklerhinweise auch im [Wiki](https://github.com/safetraliasoftware/ai-council/wiki/Entwicklung).

## Support

Fragen und Fehler: [info@safetralia.de](mailto:info@safetralia.de) · [Issues](https://github.com/safetraliasoftware/ai-council/issues)

## Lizenz

© Safetralia Software. Noch keine offene Lizenz vergeben — Quellcode ist öffentlich einsehbar, aber nicht zur freien Weiterverwendung freigegeben.
