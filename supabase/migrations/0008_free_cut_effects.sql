-- AI Creator Studio — Release 3, Etappe 8: „Freier Schnitt“ (scriptless edit plans), cuts and zoom.
-- Mirrors `EditPlan` in apps/web/src/server/store.ts. Cuts and zoom live inside `edit_plans.body`
-- (jsonb, schema contracts/edit-plan.json) and need no column.
-- Part 2 adds the transcript filler-prompt flag and silence scans (sections 3–4); the render look follows in part 3.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Release 3, Etappe 8) for where this was applied and tested.

-- 1) Scriptless plans (script_id is null, personal content only — enforced in the app) number their
--    versions per project. Rows with a null script that exist now are legacy (from before 0005 or
--    detached by a deleted script; the app never wrote scriptless plans before Etappe 8): they are
--    numbered 1..n per project in creation order so the unique index can be created.
with legacy as (
  select id, row_number() over (partition by owner_id, project_id order by created_at, id) as n
    from public.edit_plans where script_id is null
)
update public.edit_plans e set version = legacy.n from legacy
 where e.id = legacy.id and e.version <> legacy.n;
create unique index edit_plans_free_cut_version_key on public.edit_plans (owner_id, project_id, version) where script_id is null;

-- 2) A script with edit plans is no longer silently detached from them: until now deleting it set
--    `script_id` to null, which would turn a scripted plan into a scriptless one (and could collide with
--    the index above). Now the delete is refused while plans reference the script; deleting the whole
--    project still removes both (NO ACTION is checked at the end of the statement).
alter table public.edit_plans drop constraint edit_plans_script_id_owner_fkey;
alter table public.edit_plans
  add constraint edit_plans_script_id_owner_fkey foreign key (owner_id, script_id) references public.scripts (owner_id, id) on delete no action;

-- 3) Filler prompt (Etappe 8, part 2): whether whisper ran with the fixed filler prompt. Older transcripts
--    were made without it (false); a correction inherits the flag of the version it corrects.
alter table public.transcripts add column filler_prompt boolean not null default false;

-- 4) Silence scans: silence ranges of one footage clip from FFmpeg volumedetect + silencedetect (threshold
--    relative to the clip's mean volume). Source of the pause/filler suggestions, which are never stored.
--    Mirrors `SilenceScan` in apps/web/src/server/store.ts; owner-bound and RLS like 0006. ONE scan per clip, as
--    in the app (`storeSilenceScan` replaces the older one): a new scan is written with
--    `insert … on conflict (owner_id, asset_id) do update`, no history is kept (suggestions are recomputed).
create table public.silence_scans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  asset_id uuid not null,
  params jsonb not null check (jsonb_typeof(params) = 'object'),
  ranges jsonb not null default '[]'::jsonb check (jsonb_typeof(ranges) = 'array'),
  duration_sec numeric check (duration_sec is null or duration_sec >= 0),
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  constraint silence_scans_one_per_asset unique (owner_id, asset_id),
  constraint silence_scans_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint silence_scans_asset_fk foreign key (owner_id, asset_id) references public.assets (owner_id, id) on delete cascade
);
alter table public.silence_scans enable row level security;
create policy owner_all on public.silence_scans for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 5) Look of hook and overlays (Etappe 8, part 3): the resolved tokens a render was made with (pinned Style Bible
--    version or the labelled placeholder: source, style_bible_version_id, font, colours, label) and font warnings
--    from the render log. Null = no hook/overlays. Render approval compares it with the plan's current look.
--    The overlays themselves live in edit_plans.body (jsonb) and need no column. Mirrors `Render.look` in store.ts.
alter table public.renders add column look jsonb check (look is null or jsonb_typeof(look) = 'object');
