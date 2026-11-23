# AI Creator Studio

> **Work in progress.** Persönliches Lern- und Bauprojekt, noch nicht für den produktiven Einsatz gedacht. Funktionen und Datenmodell ändern sich laufend; KI-Funktionen sind bisher überwiegend im Mock-Modus getestet. Dies ist eine öffentliche Code-Kopie ohne Projektdokumentation.

Lokales Single-User-Studio für Instagram-Content: Strategie- und Markenkontext, Style Lab mit Referenzanalyse, „Meine Marke“ (Design System), Video-Editor mit Timeline, Overlays, Untertiteln und KI-Dramaturgie, Export-Paket für externe Editoren, Karussells, Stories und Wochenboard.

**Stack:** pnpm-Monorepo, Next.js (App Router) + TypeScript, Zod, Vitest, Playwright, FFmpeg mit libass, whisper.cpp, Supabase-Migrationen (Postgres, RLS), n8n für Hintergrundjobs, austauschbare KI-Provider mit deterministischem Mock-Modus.

## Lokal starten

```bash
pnpm install
cp .env.example apps/web/.env.local   # Werte eintragen; ohne KI-Schlüssel läuft alles im Mock-Modus
pnpm dev                              # http://127.0.0.1:3000
```

Tests: `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -C packages/core test`, `pnpm -C apps/web test`, `pnpm -C apps/web test:e2e`.

Keine Lizenz: Der Code darf gelesen, aber nicht weiterverwendet werden.
