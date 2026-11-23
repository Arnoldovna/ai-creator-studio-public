# n8n-Workflows

n8n orchestriert nur. Agenten-Logik, Modellwahl (Router), Budget, Validierung, Review-Gates und Persistenz laufen in der App (`apps/web`). Die Workflows rufen authentifizierte, idempotente Job-Endpunkte auf.

Das Studio hat eine **eigene n8n** auf `http://localhost:5679` (`docker-compose.yml`, Projekt `creator-studio`). Sie ist getrennt von anderen lokalen n8n-Instanzen.

| Datei | Webhook (n8n) | App-Endpunkt | Ergebnis |
|---|---|---|---|
| `WF-01-reference-analysis.json` „Analyse reference via Creator Studio“ | `POST /webhook/creator-studio/reference-analysis` `{ referenceId, idempotencyKey? }` | `POST /api/jobs/reference-analysis` | Analyse + Beobachtungen mit Status `pending` (Review in der UI nötig) |
| `WF-03-content-generation.json` „Generate content concepts via Creator Studio“ | `POST /webhook/creator-studio/content-generation` `{ brief, idempotencyKey? }` | `POST /api/jobs/content-generation` | Briefing + 3 Konzepte (Auswahl in der UI nötig) |
| `WF-06-render.json` „Render approved EDL via Creator Studio“ | `POST /webhook/creator-studio/render` `{ editPlanId, idempotencyKey? }` | `POST /api/jobs/render`, dann Polling `GET /api/jobs/video/<jobId>` | Render des **freigegebenen** Schnittplans, danach `pending_review` (Prüfung in der UI nötig) |

**Aufbau beider Workflows** (nach den offiziellen n8n-Skills, Fehlerbehandlung für Webhook-APIs):

```
Webhook ─▶ Pflichtfeld da? ─ ja ─▶ HTTP: Studio-Job (Bearer-Credential, 2 Versuche)
                           │        ├─ Antwort ─▶ Status + Body der App durchreichen (200 / 400 / 402 Budget / 404 / 409)
                           │        └─ Fehler  ─▶ 502 {error: "upstream_error"} (App nicht erreichbar / Timeout)
                           └ nein ─▶ 400 {error: "validation_error"}
```

**Job-API-Vertrag:** `{ idempotencyKey: string(8–200), payload: {...} }` mit `Authorization: Bearer $STUDIO_JOB_TOKEN`.
- Gleicher Key ⇒ gespeichertes Ergebnis (`replayed: true`), kein erneuter kostenpflichtiger Agentenlauf.
- Ohne eigenen Key erzeugen die Workflows einen Schlüssel pro n8n-Execution. Retries werden dadurch nicht doppelt abgerechnet, ein neuer Aufruf läuft neu.

**WF-06 (Release 3, Etappe 6)** löst nur aus und fragt ab:

```
Webhook ─▶ editPlanId da? ─ ja ─▶ [Higgsfield-B-Roll, deaktiviert] ─▶ HTTP: Render starten (Bearer)
                         │        ├─ 200 ─▶ 202 {jobId, renderId} sofort zurück ─▶ Polling-Schleife (Loop Over Items, reset)
                         │        │           Wait 10 s ─▶ GET /api/jobs/video/<jobId> ─▶ fertig?
                         │        │             ├─ ja: Job succeeded ─▶ Ende „Render finished“ (Render wartet auf Prüfung) │ failed/cancelled ─▶ Stop and Error
                         │        │             └─ nein: ≥ 180 Runden (30 min)? ─▶ Stop and Error │ sonst nächste Runde
                         │        ├─ jede andere App-Antwort (401 Token, 404, 409 „nicht freigegeben“, 429, 5xx) ─▶ Status + Body durchgereicht
                         │        └─ keine Antwort (Netzwerk/Timeout, 2 Versuche) ─▶ 502 upstream_error
                         └ nein ─▶ 400 validation_error
```

- n8n gibt nichts frei: Die App rendert nur freigegebene Schnittpläne mit freigegebenem Skript (sonst 409). Die Prüfung des Renders passiert im Video Studio.
- Kein HTTP-Aufruf mit 300 s Timeout: Der Start antwortet sofort, der Status kommt per Polling.
- Der Higgsfield-Zweig ist ein deaktivierter Platzhalter (Etappe 7, nur nach Credit-Freigabe in der App).
- Default-Schlüssel `n8n-wf06-exec-<executionId>`. Die App verlangt mindestens 8 Zeichen; das alte `wf03-<id>` war bei kleinen Execution-IDs zu kurz (beim WF-06-Test gefunden, in WF-03 korrigiert).

## Einrichtung (lokal)

1. **App:** In `apps/web/.env.local` `STUDIO_JOB_TOKEN=<langes Zufallstoken>` setzen und die App starten (`pnpm dev`).
2. **n8n starten:** Im Repo-Root eine `.env` mit `N8N_ENCRYPTION_KEY=<zufällig>` anlegen (gitignored), dann `docker compose up -d n8n`.
   - Die n8n bindet nur `127.0.0.1:5679`.
   - `N8N_EDITOR_BASE_URL` steht auf `http://localhost:5679`, das braucht die MCP-Anmeldung.
3. **n8n einrichten:** In http://localhost:5679 das Besitzer-Konto anlegen und **Settings → Instance-level MCP** einschalten.
4. **Credential anlegen:** Typ **Bearer Auth**, Name **`Studio Job Token`**, Token = Wert von `STUDIO_JOB_TOKEN`. Das macht man in der n8n-Oberfläche; der n8n-MCP kann keine Credentials anlegen.
5. **Workflows:**
   - **Neu bauen** mit Claude Code über den n8n-MCP: `claude mcp add --scope local --transport http n8n-studio http://localhost:5679/mcp-server/http`, dann in `/mcp` anmelden.
   - **Oder importieren:** `docker exec creator-studio-n8n-1 n8n import:workflow --input=…` aus `workflows/`. Danach in beiden HTTP-Knoten das Credential auswählen und veröffentlichen.

## Verifiziert (2026-11-15)

Gegen **n8n 2.47.7** (Studio-Instanz, Docker Desktop, macOS), gebaut über den n8n-MCP mit den Skills von `n8n-skills@n8n-io` 1.3.0:

- `validate_workflow` ok; `get_workflow_details`: Verbindungen und Credential-Bindung per ID wie geplant.
- `test_workflow` mit Testdaten:
  - WF-03 Erfolgspfad (200)
  - WF-03 ohne `brief`: 400, der Job wird nicht aufgerufen
  - WF-01 mit App-Status 402: wird durchgereicht
- Veröffentlicht; Produktions-Webhooks gegen die laufende App (`pnpm dev`, `AI_PROVIDER=openrouter`):
  - WF-03 ohne `brief`: 400 `validation_error`
  - WF-01 mit unbekannter Referenz: Token akzeptiert, 404 der App durchgereicht
  - **WF-03 echt:** 3 Konzepte über den Router (Gemini 3.8 Flash), 15 s, 0,008 USD (von OpenRouter gemeldet). Zweiter Aufruf mit gleichem Key: `replayed: true`, 0,14 s, keine Kosten.

**Nicht getestet:**
- WF-01 mit echter Bildanalyse über n8n (über die API live getestet, siehe `docs/IMPLEMENTATION_LOG.md`)
- Workflow-weiter Error-Workflow (laut Skill für unbeaufsichtigte Workflows empfohlen; die Webhooks antworten hier synchron)
- Linux-Host (die App lauscht nur auf 127.0.0.1, siehe `docker-compose.yml`)
- Last und Timeouts

## Verifiziert WF-06 (2026-11-15)

Gegen **n8n 2.47.7** (Studio-Instanz). Der n8n-MCP war in dieser Sitzung nicht verbunden; Import und Veröffentlichung liefen über die n8n-CLI (`import:workflow`, `publish:workflow`), die Ausführungen wurden in der n8n-Datenbank nachgelesen.

- Testkopie (Webhook `creator-studio/render-test`, Ziel eine **getrennte** App-Instanz auf Port 3101 mit leerem Datenordner und Mock-Modus, Wartezeit 2 s); die echten Daten der Nutzerin wurden nicht berührt:
  - ohne `editPlanId`: 400 `validation_error`, die App wird nicht aufgerufen
  - unbekannter Schnittplan: 404 der App durchgereicht
  - **Entwurf (nicht freigegeben): 409 „Nur freigegebene Schnittpläne werden gerendert.“**
  - freigegebener Schnittplan: sofort 202 mit `jobId`; Polling bis `pending_review`, Ausführung `success` im Endknoten (≈ 10 s, echter FFmpeg-Render)
  - gleicher Schlüssel erneut: derselbe Job, `replayed: true`, kein zweiter Render
- Gefunden und behoben: Der Default-Schlüssel war bei kleinen Execution-IDs zu kurz (400 der App).
- Nach dem Review geändert: Endbedingung ist jetzt „Job succeeded“ (ein schon geprüfter oder gelöschter Render ist kein Fehler mehr), `editPlanId` wird lose geprüft (eine Zahl ergibt 400 der App statt eines n8n-Fehlers), Fehlertexte kommen ohne lokale Pfade, Polling stößt nach einem App-Neustart wartende Jobs an. Diese Fassung ist neu importiert; erneut geprüft: ohne `editPlanId` → 400; unbekannte ID gegen die echte App → 404 (nur gelesen, nichts angelegt). Der Erfolgsfall ist mit dieser Fassung nicht wiederholt.
- Danach: Testkopie **deaktiviert** (die n8n-CLI kann keine Workflows löschen; „TEST COPY WF-06“ bitte in der n8n-Oberfläche löschen), Test-App beendet, Testdaten gelöscht. Das echte WF-06 (`creator-studio/render`, App auf Port 3000) ist importiert und veröffentlicht.

**Nicht getestet:** WF-06 gegen die echte App mit echten Daten der Nutzerin; die Zweige „Render fehlgeschlagen“ und „30-min-Limit“ in n8n (die App-Seite ist per Unit-Test abgedeckt). WF-03 mit dem korrigierten Schlüssel ist neu importiert und veröffentlicht (Webhook ohne `brief` → 400 geprüft), ein echter Konzeptlauf darüber aber nicht wiederholt.
