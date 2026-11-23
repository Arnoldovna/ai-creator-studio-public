-- AI Creator Studio — Release 3, Etappen 3 + 4: video jobs, persistent budget reservations,
-- versioned EDLs and reviewed renders. Mirrors `MediaJob`, `BudgetReservation`, `EditPlan` and
-- `Render` in apps/web/src/server/store.ts.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Release 3, Etappe 4) for where this was applied and tested.

-- 3) Media jobs use workflow_jobs: async states, progress and cancel.
alter table public.workflow_jobs
  add column progress numeric check (progress is null or (progress >= 0 and progress <= 1)),
  add column progress_note text not null default '' check (length(progress_note) <= 200),
  add column cancel_requested boolean not null default false,
  add column started_at timestamptz,
  add column finished_at timestamptz;
update public.workflow_jobs set status = 'failed' where status not in ('queued', 'running', 'succeeded', 'failed', 'cancelled');
alter table public.workflow_jobs
  add constraint workflow_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled'));

-- Worst-case cost of a paid call in flight; rows of a crashed process stay until the user releases them.
create table public.budget_reservations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  amount_usd numeric(12,5) not null check (amount_usd >= 0),
  purpose text not null check (length(purpose) <= 200),
  process_id text not null,
  created_at timestamptz not null default now()
);
alter table public.budget_reservations enable row level security;
create policy owner_all on public.budget_reservations for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- 4) Versioned EDL per script; approved versions are never changed (edits create a new version).
-- Rows from before 0005 (none in the app so far) become version 1 drafts.
alter table public.edit_plans
  add column version integer not null default 1 check (version >= 1),
  add column parent_id uuid,
  add column status text not null default 'draft' check (status in ('draft', 'approved')),
  add column duration_sec numeric check (duration_sec is null or (duration_sec > 0 and duration_sec <= 180)),
  add column disclosures text[] not null default '{}',
  add column warnings text[] not null default '{}',
  add column client_consent_note text check (client_consent_note is null or length(client_consent_note) <= 500),
  add column style_version_id uuid,
  add column voice_version_id uuid,
  add column approved_at timestamptz,
  add constraint edit_plans_approved_at check ((status = 'approved') = (approved_at is not null)),
  -- owner-bound like 0003: parent and versions must belong to the same owner
  add constraint edit_plans_parent_fk foreign key (owner_id, parent_id) references public.edit_plans (owner_id, id) on delete set null (parent_id),
  add constraint edit_plans_style_fk foreign key (owner_id, style_version_id) references public.style_bible_versions (owner_id, id),
  add constraint edit_plans_voice_fk foreign key (owner_id, voice_version_id) references public.voice_guide_versions (owner_id, id);
create unique index edit_plans_script_version_key on public.edit_plans (owner_id, script_id, version) where script_id is not null;

-- Renders wait for review; the file is an asset of kind 'render'. Legacy status values map to the new set.
alter table public.renders alter column status set default 'rendering';
update public.renders set status = case status when 'queued' then 'rendering' when 'done' then 'pending_review' else 'failed' end
  where status not in ('rendering', 'pending_review', 'approved', 'rejected', 'failed', 'cancelled');
alter table public.renders
  add column job_id uuid,
  add column duration_sec numeric,
  add column sha256 text check (sha256 ~ '^[0-9a-f]{64}$'),
  add column loudness jsonb,
  add column disclosures text[] not null default '{}',
  add column review_note text not null default '' check (length(review_note) <= 1000),
  add column finished_at timestamptz,
  add column reviewed_at timestamptz,
  add constraint renders_status_check check (status in ('rendering', 'pending_review', 'approved', 'rejected', 'failed', 'cancelled')),
  -- a render under or after review has its file
  add constraint renders_output_present check (status not in ('pending_review', 'approved') or output_asset_id is not null),
  add constraint renders_reviewed_at check ((status in ('approved', 'rejected')) = (reviewed_at is not null)),
  add constraint renders_job_fk foreign key (owner_id, job_id) references public.workflow_jobs (owner_id, id) on delete set null (job_id);

create index edit_plans_owner_project_created_idx on public.edit_plans (owner_id, project_id, created_at desc);
create index renders_owner_plan_created_idx on public.renders (owner_id, edit_plan_id, created_at desc);
