-- AI Creator Studio — Release 3, Etappe 7: generated B-roll via the Higgsfield CLI (ADR-010).
-- Mirrors `Generation`, `Project.aiBroll` and `MediaAsset.generation` in apps/web/src/server/store.ts.
-- The gates live in the app (quote → per-clip credit approval → one create without retry → asset review);
-- the constraints below make the recorded states consistent with them.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Release 3, Etappe 7) for where this was applied and tested.

-- Opt-in per project with its own credit budget (no budget without the opt-in).
alter table public.projects
  add column ai_broll_opt_in_at timestamptz,
  add column ai_broll_credit_budget integer not null default 0 check (ai_broll_credit_budget >= 0),
  add constraint projects_ai_broll_budget_needs_opt_in check (ai_broll_opt_in_at is not null or ai_broll_credit_budget = 0);

-- Generated assets carry their review state; they enter an EDL only when approved.
alter table public.assets
  add column generation_review text check (generation_review in ('pending', 'approved', 'rejected'));
update public.assets set generation_review = 'pending' where kind = 'generated';
alter table public.assets
  add constraint assets_generation_review check ((kind = 'generated') = (generation_review is not null));

create table public.generations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- null after the project was deleted: the row stays for the monthly credit accounting, without the prompt
  project_id uuid,
  script_id uuid,
  storyboard_id uuid not null,
  brief_index integer not null check (brief_index between 0 and 20),
  scene_index integer not null check (scene_index between 0 and 99),
  -- text-to-video only: no image inputs, so no faces, client material or Soul IDs reach Higgsfield
  model text not null check (model in ('seedance_2_5', 'kling3_0', 'veo3_1_lite')),
  prompt text not null check (length(prompt) between 1 and 1200),
  duration_sec integer not null check (duration_sec between 1 and 10),
  -- null = set by the model: only seedance_2_5 has a resolution param (CLI 1.2.3, `higgsfield model get`)
  resolution text check (resolution in ('720p', '1080p')),
  mock boolean not null default false,
  status text not null default 'quoted'
    check (status in ('quoted', 'queued', 'running', 'review', 'approved', 'rejected', 'failed', 'cancelled')),
  quoted_credits numeric(12, 2) not null check (quoted_credits >= 0),
  quoted_at timestamptz not null default now(),
  approved_max_credits numeric(12, 2),
  approved_at timestamptz,
  submitted_at timestamptz,
  higgsfield_job_id text check (higgsfield_job_id ~ '^[A-Za-z0-9_-]{4,100}$'),
  job_id uuid,
  asset_id uuid,
  credits_charged numeric(12, 2) check (credits_charged >= 0),
  failure text check (failure in ('needs_login', 'needs_workspace', 'rate_limited', 'nsfw', 'ip_detected', 'timeout', 'invalid', 'cancelled', 'failed')),
  error text check (length(error) <= 400),
  review_note text not null default '' check (length(review_note) <= 1000),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  constraint generations_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete set null (project_id),
  constraint generations_script_fk foreign key (owner_id, script_id) references public.scripts (owner_id, id) on delete set null (script_id),
  constraint generations_asset_fk foreign key (owner_id, asset_id) references public.assets (owner_id, id) on delete set null (asset_id),
  -- every state after `quoted` has an explicit credit approval at or above the quote
  constraint generations_approval check ((status = 'quoted') = (approved_max_credits is null) and (approved_max_credits is null) = (approved_at is null)),
  constraint generations_approval_covers_quote check (approved_max_credits is null or approved_max_credits >= quoted_credits),
  -- a finished clip was submitted exactly once; ended rows say what was charged
  constraint generations_submitted check (status not in ('running', 'review', 'approved', 'rejected') or submitted_at is not null),
  constraint generations_charged check (status not in ('review', 'approved', 'rejected', 'failed', 'cancelled') or credits_charged is not null),
  -- asset review: a decision has a timestamp, a rejection a reason
  constraint generations_reviewed check (status not in ('approved', 'rejected') or reviewed_at is not null),
  constraint generations_reject_reason check (status <> 'rejected' or length(btrim(review_note)) >= 3),
  constraint generations_resolution check ((model = 'seedance_2_5') = (resolution is not null))
);
alter table public.generations enable row level security;
create policy owner_all on public.generations for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- project deleted (FK sets project_id null): keep the row for the credit sum, drop the prompt like the app does
create function public.generations_scrub_on_project_delete() returns trigger language plpgsql as $$
begin
  if old.project_id is not null and new.project_id is null then
    new.prompt := '[Projekt gelöscht]';
    new.asset_id := null;
  end if;
  return new;
end $$;
create trigger generations_scrub_on_project_delete before update of project_id on public.generations
  for each row execute function public.generations_scrub_on_project_delete();
create index generations_owner_project_idx on public.generations (owner_id, project_id, created_at desc);
-- monthly credit sums
create index generations_owner_approved_idx on public.generations (owner_id, approved_at) where approved_at is not null;
