-- AI Creator Studio initial draft schema for Supabase Postgres.
-- STATUS: Applied to a local Supabase stack (CLI 3.1.0, Postgres 17.11) via `supabase db reset` and checked by `pnpm test:db` (pgTAP); also tested against PGlite. NOT yet applied to a hosted Supabase project.
create extension if not exists pgcrypto;

create table public.creative_profiles (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 name text not null, profile_kind text not null check (profile_kind in ('personal','client')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.references (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete cascade,
 media_kind text not null check (media_kind in ('image','video','design','website','text','audio')),
 storage_path text, source_url text, source_credit text, rights_note text,
 notes text not null default '', tags text[] not null default '{}',
 extracted_palette jsonb not null default '[]'::jsonb,
 created_at timestamptz not null default now()
);
create table public.reference_observations (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 reference_id uuid not null references public.references(id) on delete cascade,
 dimension text not null, observation text not null,
 evidence jsonb not null default '{}'::jsonb, confidence numeric check (confidence between 0 and 1),
 decision text not null default 'pending' check (decision in ('pending','approved','rejected')),
 feedback text, created_at timestamptz not null default now()
);
create table public.style_bible_versions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete cascade,
 version integer not null check (version >= 1), status text not null default 'draft' check (status in ('draft','approved','archived')),
 rules jsonb not null, markdown text not null default '', created_at timestamptz not null default now(),
 unique (profile_id, version)
);
create table public.voice_guide_versions (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete cascade,
 version integer not null check (version >= 1), status text not null default 'draft' check (status in ('draft','approved','archived')),
 rules jsonb not null, markdown text not null default '', created_at timestamptz not null default now(),
 unique (profile_id, version)
);
create table public.projects (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete restrict,
 project_kind text not null check (project_kind in ('personal','ugc_client')),
 title text not null, status text not null default 'draft',
 style_version_id uuid references public.style_bible_versions(id),
 voice_version_id uuid references public.voice_guide_versions(id),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.briefs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 brief jsonb not null, created_at timestamptz not null default now()
);
create table public.research_reports (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 report jsonb not null, source_manifest jsonb not null default '[]'::jsonb, created_at timestamptz not null default now()
);
create table public.concepts (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 body jsonb not null, status text not null default 'draft' check (status in ('draft','approved','rejected')),
 style_version_id uuid references public.style_bible_versions(id), voice_version_id uuid references public.voice_guide_versions(id),
 created_at timestamptz not null default now()
);
create table public.scripts (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 concept_id uuid not null references public.concepts(id) on delete cascade,
 version integer not null check (version >= 1), body jsonb not null,
 status text not null default 'draft' check (status in ('draft','approved','rejected')),
 created_at timestamptz not null default now(), unique (concept_id, version)
);
create table public.assets (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid references public.projects(id) on delete cascade,
 storage_path text not null, mime_type text not null, size_bytes bigint not null check (size_bytes >= 0),
 origin text not null check (origin in ('own','licensed','client','generated')),
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.edit_plans (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 script_id uuid references public.scripts(id) on delete set null,
 project_id uuid not null references public.projects(id) on delete cascade,
 body jsonb not null, created_at timestamptz not null default now()
);
create table public.renders (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 edit_plan_id uuid not null references public.edit_plans(id) on delete cascade,
 status text not null default 'queued', output_asset_id uuid references public.assets(id),
 error text, created_at timestamptz not null default now()
);
create table public.publications (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid not null references public.projects(id) on delete cascade,
 render_id uuid references public.renders(id), platform text not null default 'instagram',
 platform_media_id text, published_at timestamptz, metrics_provenance text,
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.metric_snapshots (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 publication_id uuid not null references public.publications(id) on delete cascade,
 observed_at timestamptz not null, source text not null check (source in ('manual','instagram_api','file_import')),
 metrics jsonb not null, coverage jsonb not null default '{}'::jsonb,
 unique (publication_id, observed_at, source)
);
create table public.growth_insights (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete cascade,
 evidence jsonb not null, hypothesis text not null, confidence text not null default 'low',
 approved boolean not null default false, created_at timestamptz not null default now()
);
create table public.experiments (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 profile_id uuid not null references public.creative_profiles(id) on delete cascade,
 insight_id uuid references public.growth_insights(id), hypothesis text not null,
 metric_name text, status text not null default 'planned', results jsonb,
 created_at timestamptz not null default now()
);
create table public.agent_runs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid references public.projects(id) on delete cascade,
 agent_name text not null, prompt_version text not null, model text not null,
 input_hash text, output jsonb, status text not null default 'pending',
 cost_estimate_usd numeric(12,5), error text, created_at timestamptz not null default now()
);
create table public.workflow_jobs (
 id uuid primary key default gen_random_uuid(), owner_id uuid not null references auth.users(id) on delete cascade,
 project_id uuid references public.projects(id) on delete cascade,
 workflow_name text not null, idempotency_key text not null unique,
 status text not null default 'queued', attempts integer not null default 0,
 payload jsonb not null default '{}'::jsonb, error text, created_at timestamptz not null default now()
);

-- Prototype RLS: isolate records per authenticated owner. More restrictive service API
-- authorization and storage policies are required before production use.
do $$
declare table_name text;
begin
 foreach table_name in array array[
   'creative_profiles','references','reference_observations','style_bible_versions',
   'voice_guide_versions','projects','briefs','research_reports','concepts','scripts',
   'assets','edit_plans','renders','publications','metric_snapshots','growth_insights',
   'experiments','agent_runs','workflow_jobs'
 ] loop
   execute format('alter table public.%I enable row level security', table_name);
   execute format('create policy owner_all on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', table_name);
 end loop;
end $$;

create index on public.references (owner_id, profile_id, created_at desc);
create index on public.concepts (owner_id, project_id, created_at desc);
create index on public.metric_snapshots (owner_id, publication_id, observed_at desc);
create index on public.workflow_jobs (owner_id, status, created_at desc);
