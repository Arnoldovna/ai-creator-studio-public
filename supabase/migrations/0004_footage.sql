-- AI Creator Studio — Release 3, Etappe 2: project footage with rights provenance.
--
-- `public.assets` (0001) already holds storage path, MIME, size and origin. Footage additionally needs:
-- the user's name for the file, a content hash (dedup per project), the confirmed rights with a note
-- for licensed/client material, and the ffprobe metadata. Mirrors `MediaAsset` in apps/web/src/server/store.ts.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Release 3, Etappe 2) for where this was applied and tested.

alter table public.assets
  add column name text,
  add column kind text not null default 'footage' check (kind in ('footage', 'render', 'generated')),
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column rights_note text not null default '' check (length(rights_note) <= 500),
  add column rights_confirmed_at timestamptz,
  add column probe jsonb,
  add column probe_status text check (probe_status in ('probed', 'probe_failed', 'probe_unavailable'));

-- Rows that existed before 0004 (none in the app so far) must satisfy the new checks:
update public.assets set kind = 'generated' where origin = 'generated';
update public.assets set rights_confirmed_at = created_at where kind = 'footage' and rights_confirmed_at is null;
update public.assets set rights_note = 'Bestand vor 0004 – Quelle nicht erfasst' where origin in ('licensed', 'client') and length(btrim(rights_note)) < 3;

-- Uploaded footage needs confirmed rights; licensed and client footage also a source/licence note.
alter table public.assets
  add constraint assets_footage_rights_confirmed check (kind <> 'footage' or rights_confirmed_at is not null),
  add constraint assets_rights_note_required check (origin not in ('licensed', 'client') or length(btrim(rights_note)) >= 3),
  -- generated media is never uploaded as footage (Higgsfield assets arrive via their own gated flow)
  add constraint assets_generated_kind check ((origin = 'generated') = (kind = 'generated'));

create unique index assets_project_sha256_key on public.assets (owner_id, project_id, sha256) where sha256 is not null;
create index assets_owner_project_created_idx on public.assets (owner_id, project_id, created_at desc);
