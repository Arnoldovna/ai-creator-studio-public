-- AI Creator Studio — Etappe 11: Strategie, Profil und Quellen als Dokumente (E1/E3/E9, docs/PLAN-UMBAU-10-17.md).
--
-- Mirrors apps/web/src/server/store.ts (db.json schema 2):
--   ContextVersion → public.context_versions
--     id, profileId, kind ('strategy' | 'profile' | 'source'), sourceKey, version, status, document, aiTextHash,
--     source, createdAt, approvedAt
--     `document` is the whole document (packages/core/src/contextDoc.ts): StrategyDocument (incl. its optional
--     Markdown attachment), ProfileDocument or SourceDocument. `markdown` and `send_mode` repeat the Markdown body and
--     the send switch (profile/source body, strategy attachment) as columns, so a runtime adapter can read and limit
--     them without parsing jsonb. `document_format` 2 = Etappe-11 document; 1 = a row written before this migration
--     (its jsonb is the old `aiSafe` part only – the local part was never mirrored; the app converts it on its side).
--   SelfAssessment → public.self_assessments: the note is stored on the record now (`note`), `has_note` is gone.
--   StrategyGate   → public.strategy_gates: override reasons live inside the existing jsonb arrays (`reason`).
--
-- User decision (19.11.): „Die KI darf alles lesen“ – there is no separate local-only part any more, so the
-- mirror holds the whole document. RLS stays owner-bound as in 0009.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 11) for where this was validated. NOT applied to a hosted project.

-- 1) context_versions: whole documents, a third kind for sources, more origins, optional hash
alter table public.context_versions rename column ai_safe to document;
alter table public.context_versions
  add column document_format smallint not null default 1 check (document_format in (1, 2)),
  add column source_key text check (source_key is null or source_key ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  add column markdown text check (markdown is null or char_length(markdown) <= 200000),
  add column send_mode text check (send_mode is null or send_mode in ('always','chat_voice_only','never')),
  drop column import_warnings;
-- new rows are documents unless they say otherwise
alter table public.context_versions alter column document_format set default 2;

alter table public.context_versions drop constraint context_versions_kind_check;
alter table public.context_versions add constraint context_versions_kind_check check (kind in ('strategy','profile','source'));
alter table public.context_versions drop constraint context_versions_source_check;
alter table public.context_versions add constraint context_versions_source_check
  check (source in ('import','manual','copy','defaults','import_bundle','migration'));
alter table public.context_versions alter column ai_text_hash drop not null;
alter table public.context_versions drop constraint context_versions_ai_text_hash_check;
alter table public.context_versions add constraint context_versions_ai_text_hash_check check (ai_text_hash is null or ai_text_hash ~ '^[0-9a-f]{64}$');

-- a source has a key, a body and a switch; strategy/profile have no key
alter table public.context_versions add constraint context_versions_source_key
  check ((kind = 'source') = (source_key is not null));
alter table public.context_versions add constraint context_versions_source_body
  check (kind <> 'source' or (markdown is not null and send_mode is not null));

-- one version line per (profile, kind) and, for sources, per key; one active version per line
alter table public.context_versions drop constraint context_versions_version_key;
create unique index context_versions_version_key on public.context_versions (owner_id, profile_id, kind, coalesce(source_key, ''), version);
drop index public.context_versions_one_approved;
create unique index context_versions_one_approved on public.context_versions (owner_id, profile_id, kind, coalesce(source_key, '')) where status = 'approved';

-- 2) self_assessments: the note on the record (was local-only in Etappe 9/10)
alter table public.self_assessments
  add column note text not null default '' check (char_length(note) <= 1000),
  drop column has_note;
