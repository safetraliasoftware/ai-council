# AI Council: Abgleich mit der Endvision

## Fortschreibung nach Umsetzung (2026-09-18)

Aktualisiert die Fortschreibung vom 13.09. - für den aktuellen Stand gilt diese neuere Fassung, die vorherige bleibt darunter als Zwischenstand erhalten. Auslöser dieses Blocks: ein zweites reales Projekt ist durch die Pipeline gelaufen - nicht mehr nur der Taschenrechner, sondern ein Unreal-Engine-Spiel ("ProjektLuftbrücke", drei Tasks von Spielstart/Flugplanung über Flug-/Wartungsbetrieb bis zum gepackten Windows-Build). Das bestätigt praktisch die von André ausdrücklich domänenneutral benannte Endvision (Marketing bis eigene Spiele) und hat erneut echte, vorher unsichtbare Lücken aufgedeckt - diesmal vor allem rund um lange Agentenläufe und Nutzungslimits, nicht mehr um Policy/Workspace-Integrität wie beim vorigen Block:

- **Erster echter Baustein für M6s Budget-/Usage-Ledger**: jeder Council- und Ausführungsaufruf wird jetzt mit Zeichen/Tokens/Kosten/Ergebnis in einer eigenen, absturzsicheren `usage.db` protokolliert (abgebrochene "running"-Einträge werden beim nächsten Start als unterbrochen markiert). Zwei getrennte Ebenen: reine Anzeige (Council- und Ausführungs-Nutzung zusammengeführt, ohne Doppelzählung, bewusst ohne Behauptung über verbleibendes Abo-Kontingent) und ein **tatsächlich durchgesetztes** `TaskBudget` (maxCalls/maxCorrections/maxActiveMs) pro Task.
- **Neuer, kontrollierter Versuchsstatus `paused` mit echtem Wiederaufsetzen**: live ausgelöst durch ein erschöpftes Claude-Code-Sitzungslimit mitten in einem Luftbrücke-Task. Statt als `failed` zu enden, pausiert der Versuch; ein erneuter Start desselben Tasks erkennt den pausierten, wiederholbaren Versuch (`project-engine.ts`s `resumePaused`-Zweig) und setzt fort statt einen neuen Versuch zu verbrauchen - genau die zuvor nur als Idee vorgemerkte "Auto-Resume nach Reset"-Fähigkeit, jetzt als kontrolliertes Wiederaufsetzen (nicht automatisch zeitgesteuert, sondern beim nächsten menschlichen Start).
- **Worktree-Persistenz über Neustarts hinweg**: ein neuer dateibasierter `WorktreeStore` merkt sich Workflow-Worktrees, damit Merge/Discard auch nach einem App-Neustart noch funktionieren - vorher nur im flüchtigen In-Memory-Zustand von `project-engine.ts` verfügbar.
- **Geordnetes Herunterfahren**: `before-quit` wartet jetzt auf laufende Versuche/Engine-Abschluss, stoppt Kindprozesse und flusht Event-Log/Datenbanken (mit Timeout und blockierendem Dialog bei hängenden Läufen), statt hart zu beenden.
- **Preflight-Prüfungen vor jeder Task-Ausführung**: Arbeitsverzeichnis beschreibbar, `git` und die konfigurierten Prüfbefehle im PATH auflösbar, gewählte Coding-Executoren installiert und angemeldet - schlägt kontrolliert vor dem eigentlichen Lauf fehl statt mitten im Agentenlauf.
- **Fehlerklassifikation für Retry-/Eskalations-UX** (`task-control.ts`): Fehlertext wird in `authentication|quota|policy|storage|cancelled|implementation|budget|process` eingeordnet - Grundlage für sinnvoll unterschiedliches Verhalten statt einer einzigen generischen Fehlermeldung.
- **Kontextbegrenzung für Korrekturrunden** (`workflow-evidence.ts`): Kommando-Ausgaben werden auf ca. 6 KB gekürzt (Anfang+Ende behalten), bestandene Reviews aus dem Korrekturkontext entfernt - begrenzt die Prompt-Größe bei mehreren Korrekturrunden, ohne die eigentliche Fehlerevidenz zu verlieren.
- **Anhänge für Council/Compare/Team**: ein Git-Diff, eine Datei oder ein vergangener Coding-/Workflow-Lauf lässt sich jetzt als benannter Textblock an einen Prompt anhängen, statt alles von Hand einzutippen.

Validierung: 467 automatisierte Tests bestanden (123 coding, 20 council-core, 14 council-participants, 3 providers, 18 task-graph, 289 desktop), Typprüfung und Produktionsbuild erfolgreich.

Weiter offen, unverändert seit dem 13.09.: Company Truth hat weiterhin **keine** Versionierung/Vorschlagsfreigabe - reines CRUD (Punkt 8, Rest von M5). Der neue `ProjectPicker`/`ProjectProfile` bleibt eine reine Kurzbefehl-Ablage (Name + Arbeitsverzeichnis + Standard-Rechtestufe), noch **nicht** mit der eigentlichen Projekt-Identität (Spec/TaskGraph/Event-Log) unter einer gemeinsamen ID verbunden (Punkt 20 "dauerhafte Workspaces" bleibt Lücke, auch wenn jetzt mehr Einzelteile dafür existieren). M4 (Vendor-Neutralität), Event Sourcing für vollständige Task-Lauf-Historie (Punkt 18), Command Center (Punkt 24) und Business Councils (Punkt 21) unverändert offen.

**Ein prozessuales Risiko, unabhängig vom Vision-Abgleich**: das gesamte Repository besteht weiterhin nur aus einem einzigen "Initial commit" - der komplette seit dem 10.09. entstandene Funktionsumfang (Policy Engine, ChangeRequests, SQLite-Migration, drei CLI-Executoren, jetzt Usage/Budget/Pause-Resume) liegt uncommitted im Arbeitsverzeichnis, ohne Wiederherstellungspunkt oder Diff-Verlauf.

Nächster produktbezogener Nachweis: unverändert der reale Ende-zu-Ende-Lauf, jetzt an einem zweiten, strukturell andersartigen Projekt (Spiel statt Anwendungssoftware) bereits im Gange. Fortsetzen, sobald das Sitzungslimit-Fenster es zulässt - das Muster "echter Lauf deckt echte Lücke auf" hat sich mit dem `paused`-Status erneut bestätigt.

---

## Fortschreibung nach Umsetzung (2026-09-13)

Aktualisiert die Fortschreibung vom 10.09. - für den aktuellen Stand gilt diese neuere Fassung, die vorherige bleibt darunter als Zwischenstand erhalten. Seit dem 10.09. kam ein zusammenhängender zweiter Block dazu, getrieben von echten Live-Durchläufen eines realen Taschenrechner-Projekts mit den drei installierten Agenten (nicht nur Tests) - dabei sind mehrere echte Infrastrukturlücken sichtbar geworden und geschlossen worden, nicht nur neue Features gebaut worden:

- **ChangeRequest-Prozess vollständig verbunden** (schließt den größten Teil der bei M5 offenen Lücke): Council-Bewertung liefert eine strukturierte Empfehlung (proceed/reject) neben der Freitext-Begründung; menschliches Genehmigen/Ablehnen; `applyChangeRequest()` generiert Ersatz-Tasks (auch mehrere pro invalidiertem Task, mit korrekter Dependency-Verdrahtung für alle), invalidiert harte Abhängigkeiten und markiert weiche zur Revalidierung, crash-sicher mit Wiederaufnahme statt doppelter Migration. Architektur-Eskalation (Punkt 17) ist damit real durchverbunden: Pause → Council → Gate → Spec-Änderung → Revalidierung → Fortsetzen, nicht mehr nur Typ und Task-Status.
- **Mehrere live gefundene Ausführungslücken geschlossen**: Rechte-Eskalation bei Tool-Verweigerung (`awaiting_permission`) war schon vorhanden; neu dazu kam die strukturell gleiche Stufe für ein fehlendes Werkzeug (`awaiting_install`) - erkennt einen `ENOENT`-Spawn-Fehler, schlägt einen Installationsbefehl vor (nur bei live über `winget search` bestätigten Paket-IDs), lässt den Menschen entscheiden, installiert und liest PATH direkt aus der Windows-Registry neu ein, statt auf einen App-Neustart zu hoffen (live verifiziert: ein Neustart allein reichte nachweislich nicht). Das Prüfprofil-Formular schlägt jetzt automatisch passende Test-/Build-Befehle vor (Verzeichnis-Scan nach Projekt-Manifesten, sonst Schlüsselwort-Heuristik auf dem Spec-Text) statt einen Node-Default zu unterstellen - live ausgelöst durch ein .NET-Projekt, das an `npm test` scheiterte, obwohl kein `package.json` je existierte.
- **Performance**: Reviewer und Challenger liefen bisher sequenziell; laufen jetzt parallel (`Promise.all`), was die Review-Phase bei jedem Task mit Challenger etwa halbiert. Bewusster Trade-off: ein eskalierender Reviewer überspringt den anderen nicht mehr.
- **Erster echter Baustein für Punkt 15 (Policy Engine)**: ein gemeinsamer `PolicyDecision`-Typ dedupliziert zwei bis dahin unabhängig gebaute Prüfungen (Workspace-Integrität im Coding-Workflow und im Council-Pfad), die exakt dieselbe Frage unterschiedlich beantwortet hatten. Bewusst kein vollständiger zentraler Dienst - die Pro-Executor-CLI-Übersetzung bleibt executor-spezifisch, das wäre eine verfrühte Universal-Abstraktion.
- UI-Ergonomie, live als Verwirrung gemeldet und behoben: Änderungsanfragen, Versuchslimit-Erhöhung und Ablaufprotokoll-Zugriff sitzen jetzt direkt im jeweiligen Task statt in einer separaten, weit entfernten Ansicht; Council-Fortschritt scrollt beim Start automatisch zur Interaktionsstelle statt darüber wegzulaufen.

Validierung: 380 automatisierte Tests bestanden (109 coding, 14 council-core, 12 council-participants, 3 providers, 18 task-graph, 224 desktop), Typprüfung und Produktionsbuild erfolgreich. Der reale interaktive Durchlauf mit allen drei Agenten hat inzwischen mehrfach stattgefunden (nicht mehr nur simuliert) - genau das hat die oben genannten Lücken erst sichtbar gemacht.

Weiter offen, unverändert seit dem 10.09.: M4 (Vendor-Neutralität, weitere Anbieter wie Grok - auf Nutzerwunsch zurückgestellt), M6 über den seriellen Scheduler hinaus (Budget-Ledger, Parallelität, Discovery, konkurrierende Implementierungen), Event Sourcing für vollständige Task-Lauf-Historie (Punkt 18), Command Center als zusammenhängender Arbeitsraum (Punkt 24), Business Councils (Punkt 21), versionierte Company Truth mit Vorschlagsfreigabe (Rest von M5).

Neuer Kontext für künftige Priorisierung: André hat das Endziel ausdrücklich als domänenneutral benannt - vom Marketing bis zu eigenen Spielen, nicht nur Software. Das gibt Punkt 21 (Business Councils) und den Business-Workflows aus M6 mehr Gewicht, als die reine Meilenstein-Reihenfolge nahelegt - ändert aber nichts an der kurzfristigen Priorität, die Engineering-Strecke an echten Projekten weiter zu härten.

Nächster produktbezogener Nachweis: unverändert der reale Ende-zu-Ende-Lauf, nur jetzt bereits mehrfach angelaufen statt nur geplant. Fortsetzen, sobald die Nutzungslimits der Agenten das zulassen - jeder bisherige Durchlauf hat eine echte, vorher unsichtbare Lücke aufgedeckt, das Muster lohnt sich fortzusetzen statt vorzeitig auf synthetische Tests zurückzufallen.

---

## Fortschreibung nach Umsetzung (2026-09-10)

Die nachfolgenden Abschnitte dokumentieren die **ursprüngliche Bestandsaufnahme vor der Umsetzung**. Für den aktuellen Stand gilt diese Fortschreibung. Die Erweiterung über Claude, Codex und Gemini hinaus bleibt auf ausdrücklichen Nutzerwunsch zurückgestellt.

Umgesetzt ist jetzt eine zusammenhängende Engineering-Teilstrecke:

- Host-unabhängiger ProjectEngine-Service mit Spec-Gate, Run-/Attempt-IDs, dauerhaften Ereignissen und Wiederherstellung abgeschlossener Nachweise. Unterbrochene Agenten werden nach Neustart als unterbrochen markiert; ihre Worktrees bleiben erhalten. Kein automatisches Wiederanknüpfen an fremde Prozesse.
- Freigegebenes Prüfprofil mit echten Test-/Build-Prozessen, Zeitlimits und strukturierten Ergebnissen. Strikte Review-Verdicts, optionaler Challenger, Korrekturschleife und Versuchslimit. Fehlgeschlagene Prüfungen, ungültige Reviews und nachträgliche Dateiänderungen blockieren die Annahme.
- Eigener Integrations-Worktree und getrennte Task-Worktrees. Integration mit erneuter Verification, finales Council und menschliche Freigabe eines konkreten Commits. Der Quellbranch wird erst danach per Fast-forward aktualisiert; Push und Deployment sind kein Teil dieser Freigabe.
- Optionaler serieller Scheduler für bereite Tasks. Er stoppt bei Fehlern und übernimmt niemals automatisch den finalen Release.
- Vier Council-Runden einschließlich Revision; verspätete Agentenfehler entwerten Ergebnisse. Inhaltsbasierte Readonly-Prüfung. Neue Backend-Konfigurationen bevorzugen lokal per AUTO, ohne stillen API-Fallback.
- Company Truth in Planungs-, Council- und Ausführungskontexten; Architektur und direkte Dependency-Nachweise im Task-Kontext. Überarbeitete genehmigte Pläne können ausdrücklich übernommen werden; ältere Versuche bleiben archiviert.
- Persistente Ausführungsansicht mit Prüfungen, Reviews, Wiederholungen, Integration und Release. Alte direkte Schreibstarts werden auf den Spec-First-Projektpfad verwiesen.

Validierung: 214 automatisierte Tests bestanden, einschließlich echter Git-Worktrees und echter Prüfprozesse bei simulierten Agenten. Typprüfung und Produktionsbuild erfolgreich. Ein vollständiger interaktiver Desktop-Durchlauf mit allen drei real angemeldeten Agenten ist damit noch nicht nachgewiesen.

Weiter offen: Discovery/Research bis zur Spezifikation, formaler ChangeRequest-Prozess mit gezielter Revalidation, versionierte Company Truth mit Vorschlagsfreigaben, zentrale Policy Engine und Betriebssystem-Sandbox, parallele oder konkurrierende Implementierungen, Budget-Ledger und Routing sowie Business-Workflows. Readonly- und Scope-Nachkontrollen ersetzen keine Sandbox für externe Effekte. Antigravity erhält für DEV keinen pauschalen Rechte-Bypass; unbeaufsichtigte Schreibfähigkeit hängt deshalb von den offiziellen CLI-Rechten ab.

Nächster produktbezogener Nachweis: einen kleinen realen App-Auftrag mit den drei installierten Agenten vom genehmigten Plan bis zum geprüften Build durchlaufen lassen. Danach haben kontrollierte Architekturänderungen und Policy-Durchsetzung Vorrang vor zusätzlichen Anbietern oder UI-Bereichen.

---

## Ursprüngliche Bestandsaufnahme und Meilensteinplan

Stand: 2026-09-10. Grundlage: die vom Nutzer übermittelten 28 Visionspunkte und eine statische Prüfung des aktuellen Arbeitsstands einschließlich uncommitteter Dateien. Keine neue Laufzeit- oder Sicherheitszertifizierung. Vorhandene Typen, Prompts und Buttons gelten nicht als vollständig implementierte Prozesse. Die nachfolgende Planung verändert keinen Anwendungscode.

## Gesamturteil

AI Council ist derzeit ein lokaler Engineering-Prototyp mit getrennten Provider-/Executor-Adaptern, einem dreistufigen Council, versionierten Spezifikationen, einer DAG-Domäne und manuell gesteuerter Task-Ausführung in Worktrees. Die Vision eines kontrollierten, wiederherstellbaren End-to-End-Arbeitssystems ist noch nicht erreicht. Die wesentliche Lücke ist eine persistente, anbieterneutrale Workflow-Domäne mit nachweisbarer Verification, Policies und Release-Gates. Eine seriöse Prozentzahl lässt sich aus den ungleich großen Visionspunkten nicht ableiten.

## Abgleich aller 28 Punkte

| Nr. | Ziel | Stand und Abweichung |
|---|---|---|
| 1 | Zielgesteuerter Gesamtprozess | Teilweise: Spec → Council → Taskgraph → einzelne Coding-Tasks. Kein durchgehender Discovery-, Integrations- und Release-Prozess. |
| 2 | Beliebig viele Anbieter | Teilweise: Schleifen im Council sind listenbasiert, aber ProviderId ist eine feste Union aus drei Anbietern. Teilnehmeridentität und Anbieteridentität sind gekoppelt; zusätzliche Sitze desselben Anbieters sind nicht möglich. |
| 3 | Provider/Executor/Participant getrennt | Wesentliche Grundlage vorhanden: separate Verträge und API-/Agent-Adapter. Diese Trennung beibehalten. |
| 4 | Local First, BYOA/BYOK | Local/API/Auto und explizite API-Fallback-Option vorhanden. Standard-Backends stehen jedoch auf API. Neue Installationen müssen lokal bevorzugen; bestehende Nutzerentscheidungen bei Migration erhalten. |
| 5 | Vier Council-Runden | Unabhängige Antworten, anonymisierte Kritik und Synthese vorhanden. Eigene Revisionsrunde fehlt. Blockierende Einwände und Entscheidungen sind nicht als verbindliche strukturierte Ergebnisse implementiert. |
| 6 | Spec-First als harte Regel | Im Taskgraph-Ausführungspfad wird Freigabe geprüft. Direkte Coding-/Workflow-Starts verlangen keine genehmigte Spec. Requirement-Priorität ist optional. Kein globales Spec-First-Gate. |
| 7 | Kontrollierte Spec-Versionierung | Versionen, Freigaben und Supersede-Ereignisse vorhanden. ChangeRequest existiert als Typ, aber nicht als vollständiger Eskalations-/Genehmigungs-/Replan-Prozess. |
| 8 | Verbindliche Company Truth | Faktenverwaltung vorhanden, bei Compare/Team/Council optional im Prompt. Nicht durchgängig in Spec- und Task-Kontext eingebunden; keine Versionierung, Vorschlagsfreigabe und überprüfbare Regelanwendung über alle Bereiche. |
| 9 | Dynamischer DAG | Zyklenprüfung, Abhängigkeiten, Readiness, Invalidierung und Revalidation als Domänenbausteine vorhanden. Ausführung manuell; kein persistenter Scheduler. Outputs und vollständige Task-Historie fehlen im Snapshot-Modell. |
| 10 | Selektiver Kontext | Task-Prompt enthält Ziel, Task, relevante Akzeptanzkriterien und Scope. Strukturierte Dependency-Outputs, Architekturentscheidungen, Artefaktreferenzen und Company Truth fehlen. |
| 11 | Rollenbasierter Coding-Prozess | Implementer, Reviewer und Korrekturrunden vorhanden und auswählbar. Kein eigenständiger Challenger, keine direkte Testphase, kein generisches Rollenmodell und keine Finding-gesteuerte Abschlusslogik. |
| 12 | Integration- und Task-Worktrees | Task-/Workflow-Worktrees vorhanden. Merge geht direkt ins jeweilige Quellrepository; projektweite Integrationsbranch samt separatem finalen Release-Gate fehlt. |
| 13 | Konkurrierende Implementierungen | Compare vergleicht Antworten. Kein orchestrierter Wettbewerb mehrerer Implementierungen mit gemeinsamem Bewertungs- und Integrationsprozess. |
| 14 | Nicht-LLM-basierte Verification | Kein eigener VerificationRunner im Workflow. Agenten können Befehle ausführen, aber die Anwendung besitzt keine verbindliche strukturierte Build-/Testentscheidung. |
| 15 | Policy Engine | Drei Permission-Tiers und CLI-spezifische Übersetzungen vorhanden. Kein zentraler Allow/Deny/Approval-Entscheidungsdienst für Aktionen und externe Effekte. |
| 16 | Council Readonly | Readonly-Anforderung plus nachgelagerte Git-Prüfung vorhanden. Prüfung vergleicht Dateipfade/Status, nicht Dateiinhalte. Policy-Violation erscheint nach done; Council entfernt bereits gespeicherte Antworten deshalb nicht automatisch aus der Synthese. Keine vollständige Garantie. |
| 17 | Architektur-Eskalation | ChangeRequest-Typ und Task-Status escalated vorhanden. Kein verbundenes Pause → Council → Gate → Spec v2 → Revalidation → Fortsetzen. |
| 18 | Event Sourcing | Append-only Log für Spezifikationsereignisse vorhanden. Taskgraph wird als JSON-Snapshot ersetzt. Task-Läufe, Tests, Reviews, Policies und Release-Entscheidungen sind nicht vollständig replaybar. |
| 19 | Audit/Run History | IDs und Coding-/Workflow-Verlauf vorhanden. Neue Task-Ausführung hält Protokolle und Ergebnisse teilweise nur im Renderer. Keine vollständige projektweite Nachweiskette einschließlich Kosten. |
| 20 | Dauerhafte Workspaces | Projektkurzbefehle, Specs, Graphen, Verlauf und Worktrees vorhanden, aber getrennte Modelle/Speicher. Gemeinsame Project-ID mit Verification-Profil, Regeln und Agent-Konfiguration fehlt als verbindlicher Einstiegspunkt. |
| 21 | Business Councils | Wiederverwendbare Council-Grundlage vorhanden. Keine dedizierten Research-/Marketing-/Compliance-Prozesse mit Artefakten, Policies und Publishing-Gates. |
| 22 | Deterministische Workflow Engine | TaskGraph besitzt Transitionen, Coding besitzt eine Generator-Pipeline. Projekt-Lebenszyklus und dessen Seiteneffekte sind noch in Electron-IPC-Handlern organisiert; kein wiederherstellbarer Workflow-Kern. |
| 23 | Routing/Budget | Backend-Auswahl und einzelne Usage-/Cost-Felder vorhanden. Kein Aufgabenrouter, kein Budget-Ledger und kein Stop bei ausgeschöpftem Budget. Subscription-Kosten/-Restkontingente dürfen ohne belastbare Quelle nicht als exakt dargestellt werden. |
| 24 | Command Center | Viele Einzelbereiche vorhanden. App mountet jeweils nur den aktiven Tab; lokale Run-Ansichten sind deshalb nicht projektweit beständig. Gemeinsames Dashboard, Files/Diff/Tests/Approvals und Risikostatus fehlen als zusammenhängender Arbeitsraum. |
| 25 | Human Gates | Spec-/Graph-Freigabe sowie manuelle Übernahme vorhanden. Noch kein zentraler Gate-Service für Policies, ChangeRequests, Produktion und Release. |
| 26 | Ziel bis fertiger Build | Die Engineering-Teilstrecke ist begonnen. Research, Budgetführung, automatische Abarbeitung, direkte Verification, Integration Review und finaler Build-/Release-Nachweis fehlen. |
| 27 | Differenzierung | Die zentralen Bausteine sind angelegt. Belastbare Decision Memory, Traceability und durchgehende kontrollierte Automatisierung sind noch zu bauen. |
| 28 | Austauschbare UI/Anbieter/Agenten | Provider- und Taskgraph-Kern sind getrennt. Projekt-Ausführungslogik hängt jedoch an Electron-IPC; ProviderIds und Konfigurationen sind fest verdrahtet. Der nächste Ausbau sollte diese Kopplungen reduzieren. |

## Konkrete Codebelege

- [ProviderId](../packages/shared/src/contracts.ts): feste Anbieter-Union.
- [CouncilParticipant](../packages/shared/src/council-participant.ts): Sitz-ID ist ProviderId.
- [Council](../packages/council-core/src/orchestrator/council.ts): independent → critique → synthesis; done wird sofort als verwertbares Ergebnis gespeichert.
- [Backend-Defaults](../apps/desktop/src/main/backend-config.ts): API für alle drei Anbieter.
- [Coding-IPC](../apps/desktop/src/main/coding-ipc.ts): direkte Task-/Workflow-Starts ohne Spec-Gate.
- [Task-Ausführung](../apps/desktop/src/main/task-graph-execution-ipc.ts): Freigabeprüfungen, Ausführung und Statusspeicherung im Electron-Host.
- [Projekt-Domäne](../packages/project-domain/src/types.ts): ChangeRequest nur Datenmodell; ProjectEventType nur Spezifikationsereignisse.
- [Task-Kontext](../apps/desktop/src/main/task-graph-execution-prompt.ts): Prompt-basierter Scope und Akzeptanzkriterien.
- [Coding-Pipeline](../packages/coding/src/orchestrator/implement-and-review.ts): finale Findings bleiben Freitext; success folgt erfolgreichem Prozessablauf, nicht einer Prüfung auf offene Findings.
- [Worktree-Merge](../packages/coding/src/workspace/git-worktree.ts): Merge in sourceRepo statt separate Projektintegration.
- [Agent-Council](../packages/council-participants/src/agent-participant.ts): Dateimengen-/Statusvergleich und Policy-Violation nach Ergebnis.
- [TaskGraph](../packages/task-graph/src/task-graph.ts): reine Domäne mit Transitionen; failed/escalated ohne Wiederholungsprozess.
- [Task-UI](../apps/desktop/src/renderer/src/components/TaskGraphExecution.tsx): manuelle Starts, Laufdaten im Komponentenstatus.
- [App](../apps/desktop/src/renderer/src/App.tsx): bedingtes Mounten einzelner Tabs.

## Umsetzungsreihenfolge

### M1 – Einheitlicher, wiederherstellbarer Projektlauf

Jetzt umsetzbar. Kleiner, anbieterneutraler Workflow-Kern außerhalb von Electron mit ProjectId, RunId, SpecVersion, AttemptId und einem Command-/Event-Modell. Electron wird Adapter statt Eigentümer der Prozesslogik. Die ersten Zustände auf den bereits vorhandenen Engineering-Pfad begrenzen, keine abstrakte Universal-Engine vorweg bauen.

- Projektpfad, genehmigte Spec, Taskgraph und Lauf unter einer stabilen Identität zusammenführen.
- Spec-Gate für alle projektbezogenen Schreibstarts zentral prüfen. Ungenehmigte Starts auch direkt über IPC ablehnen.
- Start, Ergebnis, Fehler, Abbruch, Artefakte und menschliche Entscheidungen persistieren.
- Nach Neustart aktive Versuche als unterbrochen erkennen, tatsächlichen Prozesszustand prüfen und Wiederholen/Verwerfen anbieten. Ein Prozess darf nicht allein aufgrund eines gespeicherten Status als weiterlaufend gelten.
- Versuche getrennt führen; Wiederholung erzeugt eine neue AttemptId und erhält alte Nachweise.
- Scope/Policy-Verletzungen dürfen keine gültigen Council-/Review-Ergebnisse erzeugen.

Abnahme: Ein Lauf bleibt bei Tabwechsel sichtbar; Neustart verliert keine abgeschlossenen Ergebnisse; Doppelklick startet keinen zweiten Versuch; Retry löscht keine alten Ergebnisse; ein nicht genehmigter Schreibstart wird im Kern verweigert.

### M2 – Verification und belastbare Review-Entscheidungen

Auf M1 aufbauen, VerificationRunner als kleines unabhängiges Paket entwickelbar.

- Projektprofil mit freigegebenen Befehlen als executable + args, Arbeitsverzeichnis, Timeout und erforderlichen Prüfungen.
- Prozesse direkt starten; stdout/stderr, Exit-Code, Dauer, Abbruch und Artefakte speichern.
- Nach Implementierung und jeder Korrektur prüfen; Tests des integrierten Gesamtstands separat ausführen.
- ReviewResult mit Findings, Schweregrad, Requirement-/Dateireferenz und explizitem Verdict. Fehlendes/ungültiges Verdict bedeutet unbekannt, nicht bestanden.
- Kritische offene Findings und fehlgeschlagene Pflichtprüfungen blockieren den normalen Accept-Pfad. Eventuelle Overrides müssten ausdrücklich als eigene Policy entworfen werden.

Abnahme: Ein echter Exit-Code 1 verhindert Annahme, auch wenn der Agent Erfolg behauptet; Timeout und Abbruch werden unterschieden; Nachweise sind dem geprüften Commit/Diff zugeordnet; spätere Änderungen machen sie ungültig.

### M3 – Integrationsebene und Release-Freigabe

- Eigene Projekt-Integrationsbranch; Task-Worktrees davon ableiten.
- Geprüfte Tasks nur dort integrieren. Integrations-Verification nach jedem Merge.
- Final Council bewertet den vollständigen integrierten Stand und dessen Nachweise.
- Human Release Gate gilt für einen konkreten Commit und definierte Aktion; neue Änderungen entwerten die Freigabe.

Abnahme: Hauptbranch bleibt während Task-Arbeit unverändert. Kein Release ohne gültige Freigabe. Ein fehlgeschlagener Integrationsbuild wird nicht als projektweit fertig präsentiert.

### M4 – Vendor-Neutralität und Council v2

Die IDs bei M1 bereits generisch halten; vollständige Migration in einem eigenen Schritt.

- ParticipantId getrennt von ProviderId, ModelId und ExecutorId; Capability-/Adapter-Registry statt zentraler Anbieterlisten.
- Tests mit 1, 2, 4 und 6 Sitzen, darunter zwei Sitze desselben Anbieters.
- Revision zwischen Kritik und Synthese; konfigurierbarer Chair und transparente Ausfallregel.
- Strukturierte Einwände, Quellen/Annahmen, Risiken und blockierende Findings.
- Local-/Auto-Default für neue Nutzer; kein stiller API-Fallback.

Abnahme: Ein Fake-Anbieter lässt sich ohne Änderung der Workflow-/Taskgraph-Domäne registrieren. Ein Security-Blocker verschwindet nicht durch mehrere zustimmende Freitextantworten. Confidence wird als definierter Modellindikator und nicht als gemessene Erfolgswahrscheinlichkeit ausgewiesen.

### M5 – Kontext, Company Truth und ChangeRequests

- ContextPacket aus relevanten Requirements, versionierter Company Truth, Architekturentscheidungen, direkten Dependency-Outputs und Dateireferenzen.
- Änderungen an verbindlichen Fakten nur über Vorschlag und menschliche Freigabe.
- ChangeRequest durch Council/Gates führen; Spec-Versionen und Graph-Revisionen verknüpfen; laufende Graphen niemals still ersetzen.
- Betroffene Tasks invalidieren/revalidieren; Ergebnisse bleiben historisch erreichbar.

### M6 – Kontrollierte Autonomie

- Zunächst serieller Scheduler: nächste bereite Aufgabe, prüfbare Stopgründe, maximale Versuche, Abbruch und Wiederaufnahme.
- Danach Parallelität mit Scope-Konflikten, Integrationsreihenfolge und Ressourcenlimits.
- Budget-/Usage-Ledger; API-Ausgaben mit verlässlichen Daten messen, Unbekanntes ausdrücklich markieren.
- Discovery mit Quellenartefakten, danach konkurrierende Implementierungen und weitere Business-Workflows.

## Erster sinnvoller Produktnachweis

Eine kleine App mit wenigen abhängigen Tasks: genehmigte Spec → persistenter Lauf → Task-Implementierung → echte Tests → strukturiertes Review → Integration → Gesamtbuild → menschliche Release-Freigabe. Mindestens ein gezielter Testfehler und ein Neustart müssen in diesem Ablauf korrekt behandelt werden. Das belegt den Produktkern stärker als zusätzliche Anbieter oder weitere Tabs.

## Bewusst noch nicht einplanen

Kein IDE-Nachbau, kein paralleler Implementierungswettbewerb und kein automatisches Publishing vor stabilen Verification-, Integrations- und Policy-Gates. Keine vollständigen Restlaufzeit-/Kosten-Prozentangaben ohne definierte Messgrundlage. Neue Anbieter integrieren, nachdem die Registry den Anschluss ohne Kernänderungen erlaubt.
