-- AI Creator Studio — Etappe 12 (E7, E9): working drafts of the video editor and the derived media of footage.
-- Mirrors `EditDraft` and `MediaAsset.derived` in apps/web/src/server/store.ts.
--
-- 1) edit_drafts: ONE mutable draft per project and script (script_id null = Freier Schnitt, personal content only;
--    the app enforces the project kind). `revision` counts saves; the app refuses a save whose revision is stale
--    (`update … where revision = $expected`). Rendering takes an immutable edit_plans row (snapshot), the draft stays.
-- 2) assets.derived: proxy / thumbnail sprite / waveform peaks paths (working copies under `<owner_id>/derived/...`
--    in the private bucket; removed with the footage).
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 12) for where this was applied and tested.

create table public.edit_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  script_id uuid,
  revision integer not null default 1 check (revision >= 1),
  body jsonb not null check (jsonb_typeof(body) = 'object' and jsonb_typeof(body -> 'clips') = 'array'),
  client_consent_note text not null default '' check (length(client_consent_note) <= 500),
  base_plan_id uuid,
  last_snapshot_revision integer check (last_snapshot_revision is null or last_snapshot_revision >= 1),
  last_snapshot_plan_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint edit_drafts_owner_id_key unique (owner_id, id),
  constraint edit_drafts_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  -- a script with a draft is deleted with its project; deleting the script alone removes its draft
  constraint edit_drafts_script_fk foreign key (owner_id, script_id) references public.scripts (owner_id, id) on delete cascade,
  constraint edit_drafts_base_plan_fk foreign key (owner_id, base_plan_id) references public.edit_plans (owner_id, id) on delete set null (base_plan_id),
  constraint edit_drafts_snapshot_plan_fk foreign key (owner_id, last_snapshot_plan_id) references public.edit_plans (owner_id, id) on delete set null (last_snapshot_plan_id),
  constraint edit_drafts_snapshot_pair check ((last_snapshot_revision is null) = (last_snapshot_plan_id is null))
);
-- one draft per project and base (null script = Freier Schnitt counts as one base)
create unique index edit_drafts_one_per_base on public.edit_drafts (owner_id, project_id, coalesce(script_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table public.edit_drafts enable row level security;
create policy owner_all on public.edit_drafts for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.assets add column derived jsonb check (derived is null or jsonb_typeof(derived) = 'object');
