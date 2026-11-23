-- AI Creator Studio — Release 3, Etappe 5: transcripts of footage. Mirrors `Transcript` in
-- apps/web/src/server/store.ts. The text is a file in private storage (untrusted spoken words);
-- the row keeps the reference, the lineage of corrections and which recognizer produced it.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Release 3, Etappe 5) for where this was applied and tested.

create table public.transcripts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  asset_id uuid not null,
  version integer not null check (version >= 1),
  parent_id uuid,
  source text not null check (source in ('whisper', 'mock', 'user_edit')),
  model text check (model is null or length(model) <= 200),
  language text not null default 'de' check (length(language) <= 10),
  storage_path text not null,
  segment_count integer not null default 0 check (segment_count >= 0),
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  unique (owner_id, asset_id, version),
  -- owner-bound like 0003
  constraint transcripts_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint transcripts_asset_fk foreign key (owner_id, asset_id) references public.assets (owner_id, id) on delete cascade,
  constraint transcripts_parent_fk foreign key (owner_id, parent_id) references public.transcripts (owner_id, id) on delete set null (parent_id),
  -- a correction always has the version it corrects
  constraint transcripts_edit_has_parent check (source <> 'user_edit' or parent_id is not null)
);
alter table public.transcripts enable row level security;
create policy owner_all on public.transcripts for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create index transcripts_owner_asset_idx on public.transcripts (owner_id, asset_id, version desc);
