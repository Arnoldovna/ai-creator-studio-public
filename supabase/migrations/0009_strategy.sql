-- AI Creator Studio — Etappe 9: Strategie-Modul (ADR-012).
--
-- Mirrors these interfaces in apps/web/src/server/store.ts (camelCase → snake_case, one field per column):
--   ContextVersion  → public.context_versions
--     id, profileId, kind, version, status, aiSafe, aiTextHash, source, importWarnings, createdAt, approvedAt
--   StrategyGate    → public.strategy_gates
--     id, projectId, subject (→ concept_id | root_edit_plan_id), strategyVersionId, pillarId, answers,
--     joyExpected, withinBoundaries, confirmedAt, fitOverrides, lintOverrides, history, createdAt, updatedAt
--   SelfAssessment  → public.self_assessments
--     id, projectId, subject (→ subject_kind + subject_id), pillarId, strategyVersionId, joy, cameraComfort,
--     finished, hasNote, assessedAt, createdAt
--   Lineage pins (Etappe 9): Concept / ScriptVersion / EditPlan .strategyVersionId, .profileVersionId, .pillarId;
--     Publication .strategyVersionId, .pillarId, .editPlanId; AgentRun .strategyVersionId, .profileVersionId, .aiContextHash
--
-- Deliberately NOT mirrored (they stay in the local private file <dataDir>/private/context-local.json, ADR-012):
-- the local-only part of a context version, override reasons, self-assessment notes and lint excerpts.
-- Supabase is a mirror without local data; there is no column for any of them.
--
-- STATUS: Validated on a local Supabase stack (CLI 3.1.0, Postgres 17.11) on 2026-11-16: supabase db reset (0001-0009) exit 0,
-- pnpm test:db 61/61 (see docs/IMPLEMENTATION_LOG.md, Etappe 9). NOT applied to a hosted project.

-- 1) Context versions (strategy + profile): draft → approved → archived, one approved per (owner, profile, kind).
create table public.context_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null,
  kind text not null check (kind in ('strategy','profile')),
  version integer not null check (version >= 1),
  status text not null check (status in ('draft','approved','archived')),
  ai_safe jsonb not null check (jsonb_typeof(ai_safe) = 'object'),
  ai_text_hash text not null check (ai_text_hash ~ '^[0-9a-f]{64}$'),
  source text not null check (source in ('import','manual','copy')),
  -- fixed warning codes (ImportWarningCode), never text from the pasted JSON
  import_warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(import_warnings) = 'array'),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint context_versions_owner_id_key unique (owner_id, id),
  constraint context_versions_version_key unique (owner_id, profile_id, kind, version),
  constraint context_versions_approved_at check ((status = 'draft') = (approved_at is null)),
  constraint context_versions_profile_id_owner_fkey foreign key (owner_id, profile_id) references public.creative_profiles (owner_id, id) on delete cascade
);
create unique index context_versions_one_approved on public.context_versions (owner_id, profile_id, kind) where status = 'approved';

-- 2) Lineage pins. All nullable: null = created before Etappe 9, or a client project (no personal context).
alter table public.concepts     add column strategy_version_id uuid, add column profile_version_id uuid, add column pillar_id text;
alter table public.scripts      add column strategy_version_id uuid, add column profile_version_id uuid, add column pillar_id text;
alter table public.edit_plans   add column strategy_version_id uuid, add column profile_version_id uuid, add column pillar_id text;
alter table public.publications add column strategy_version_id uuid, add column pillar_id text, add column edit_plan_id uuid;
alter table public.agent_runs   add column strategy_version_id uuid, add column profile_version_id uuid,
  add column ai_context_hash text check (ai_context_hash is null or ai_context_hash ~ '^[0-9a-f]{64}$');

-- Pillar ids follow PillarId in packages/core/src/strategy.ts.
do $$
declare t text;
begin
  foreach t in array array['concepts','scripts','edit_plans','publications'] loop
    execute format('alter table public.%I add constraint %I check (pillar_id is null or pillar_id ~ ''^[a-z0-9][a-z0-9-]{0,39}$'')', t, t || '_pillar_id_format');
  end loop;
end $$;

-- Owner-bound FKs to context versions, ON DELETE NO ACTION: a pinned version cannot be deleted (only drafts are
-- deletable and nothing pins a draft). Deleting the owning user still succeeds because NO ACTION is checked at the
-- end of the cascading statement (as for edit_plans → scripts in 0008). Deleting a creative profile is blocked while
-- anything outside its own cascade pins one of its versions: projects already RESTRICT profile deletion (0003), and a
-- session self-assessment (project_id null) that pins a version blocks it too (23503). This is intended: check-ins
-- are never deleted as a side effect of removing a profile.
do $$
declare r record;
begin
  for r in select * from (values
    ('concepts', 'strategy_version_id'), ('concepts', 'profile_version_id'),
    ('scripts', 'strategy_version_id'), ('scripts', 'profile_version_id'),
    ('edit_plans', 'strategy_version_id'), ('edit_plans', 'profile_version_id'),
    ('publications', 'strategy_version_id'),
    ('agent_runs', 'strategy_version_id'), ('agent_runs', 'profile_version_id')
  ) as v(tbl, col) loop
    execute format(
      'alter table public.%I add constraint %I foreign key (owner_id, %I) references public.context_versions (owner_id, id) on delete no action',
      r.tbl, r.tbl || '_' || r.col || '_owner_fkey', r.col);
  end loop;
end $$;

-- A publication may name the cut it was made from. Deleting the plan only nulls the reference
-- (column-list SET NULL, Postgres ≥ 15, keeps owner_id intact as in 0003).
alter table public.publications add constraint publications_edit_plan_id_owner_fkey
  foreign key (owner_id, edit_plan_id) references public.edit_plans (owner_id, id) on delete set null (edit_plan_id);

-- Project-bound keys for the strategy gate subjects (same pattern as the (owner_id, id) keys in 0003).
alter table public.concepts   add constraint concepts_owner_project_id_key unique (owner_id, project_id, id);
alter table public.edit_plans add constraint edit_plans_owner_project_id_key unique (owner_id, project_id, id);

-- 3) Strategy gates: the FitCheck once per piece (concept, or the lineage root of a free cut) plus override MARKERS
--    ({ id, key, at, hasReason } and for lint also fingerprint + category). Override reasons and lint excerpts are
--    NEVER stored here. strategy_version_id null = no FitCheck yet (a gate that only holds lint overrides).
create table public.strategy_gates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  concept_id uuid,
  root_edit_plan_id uuid,
  strategy_version_id uuid,
  pillar_id text check (pillar_id is null or pillar_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  answers jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array'),
  joy_expected text check (joy_expected in ('ja','nein','unklar')),
  within_boundaries text check (within_boundaries in ('ja','nein')),
  confirmed_at timestamptz,
  fit_overrides jsonb not null default '[]'::jsonb check (jsonb_typeof(fit_overrides) = 'array'),
  lint_overrides jsonb not null default '[]'::jsonb check (jsonb_typeof(lint_overrides) = 'array'),
  history jsonb not null default '[]'::jsonb check (jsonb_typeof(history) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint strategy_gates_owner_id_key unique (owner_id, id),
  constraint strategy_gates_one_subject check ((concept_id is null) <> (root_edit_plan_id is null)),
  constraint strategy_gates_project_id_owner_fkey foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  -- the subject must belong to the gate's own project, so deleting one project never removes another project's FitCheck
  constraint strategy_gates_concept_id_owner_fkey foreign key (owner_id, project_id, concept_id) references public.concepts (owner_id, project_id, id) on delete cascade,
  constraint strategy_gates_root_edit_plan_id_owner_fkey foreign key (owner_id, project_id, root_edit_plan_id) references public.edit_plans (owner_id, project_id, id) on delete cascade,
  constraint strategy_gates_strategy_version_id_owner_fkey foreign key (owner_id, strategy_version_id) references public.context_versions (owner_id, id) on delete no action
);
create unique index strategy_gates_concept_key on public.strategy_gates (owner_id, concept_id) where concept_id is not null;
create unique index strategy_gates_plan_key on public.strategy_gates (owner_id, root_edit_plan_id) where root_edit_plan_id is not null;

-- 4) Self-assessments: joy, comfort on camera and „fertig“, also for sessions without a video. Display only.
--    NO note column: the note stays in the local private file (ADR-012); has_note only says that one exists.
--    subject_id is polymorphic (publication, edit plan or render) and deliberately has no FK: the check-in
--    outlives a deleted subject, as in the app.
create table public.self_assessments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  subject_kind text not null default 'session' check (subject_kind in ('session','publication','edit_plan','render')),
  subject_id uuid,
  pillar_id text check (pillar_id is null or pillar_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  strategy_version_id uuid,
  joy smallint not null check (joy between 1 and 5),
  camera_comfort smallint check (camera_comfort between 1 and 5),
  finished boolean,
  has_note boolean not null default false,
  assessed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint self_assessments_owner_id_key unique (owner_id, id),
  constraint self_assessments_subject check ((subject_kind = 'session') = (subject_id is null)),
  -- a session is not a piece: it never carries „fertig“ (so it can never count as a finished piece); every piece does
  constraint self_assessments_finished check ((subject_kind = 'session') = (finished is null)),
  constraint self_assessments_project_id_owner_fkey foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint self_assessments_strategy_version_id_owner_fkey foreign key (owner_id, strategy_version_id) references public.context_versions (owner_id, id) on delete no action
);
create index on public.self_assessments (owner_id, assessed_at desc);

-- 5) RLS like 0001: isolate every new table per authenticated owner.
do $$
declare t text;
begin
  foreach t in array array['context_versions','strategy_gates','self_assessments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;
