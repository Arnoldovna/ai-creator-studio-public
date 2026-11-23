-- AI Creator Studio — Release 0/1 alignment with the implemented TypeScript domain model
-- (apps/web/src/server/store.ts). Adds review/lineage columns, analyses, keyframes and a
-- private storage bucket.
--
-- STATUS: Applied to a local Supabase stack (CLI 3.1.0, Postgres 17.11) via `supabase db reset` and checked by `pnpm test:db` (pgTAP); also tested against PGlite. NOT yet applied to a hosted Supabase project.
-- The app currently runs in local file mode; the Supabase repository adapter is not implemented.

-- ---------- projects: project kinds as used by the app + UGC client brief ----------
alter table public.projects drop constraint if exists projects_project_kind_check;
update public.projects set project_kind = case project_kind when 'personal' then 'PERSONAL_CONTENT' when 'ugc_client' then 'UGC_CLIENT' else project_kind end;
alter table public.projects add constraint projects_project_kind_check check (project_kind in ('PERSONAL_CONTENT','UGC_CLIENT'));
alter table public.projects
  add column if not exists description text not null default '',
  add column if not exists client jsonb;

-- ---------- references ----------
alter table public.references
  add column if not exists name text not null default '',
  add column if not exists mime_type text,
  add column if not exists size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  add column if not exists sha256 text,
  add column if not exists likes text[] not null default '{}',
  add column if not exists dislikes text[] not null default '{}',
  add column if not exists ratings jsonb not null default '{}'::jsonb,
  add column if not exists status text not null default 'uploaded',
  add column if not exists updated_at timestamptz not null default now();
alter table public.references add constraint references_status_check check (status in ('uploaded','analyzed','review_required','reviewed'));
create unique index if not exists references_owner_sha256_key on public.references (owner_id, sha256) where sha256 is not null;

create table if not exists public.reference_keyframes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  reference_id uuid not null references public.references(id) on delete cascade,
  storage_path text not null,
  timestamp_sec numeric not null check (timestamp_sec >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.reference_analyses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  reference_id uuid not null references public.references(id) on delete cascade,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  provider text not null, model text not null, prompt_version text not null,
  analysis jsonb not null,
  keyframe_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.reference_observations
  add column if not exists analysis_id uuid references public.reference_analyses(id) on delete cascade,
  add column if not exists kind text not null default 'observed',
  add column if not exists colors text[] not null default '{}',
  add column if not exists mock boolean not null default false,
  add column if not exists decided_at timestamptz;
alter table public.reference_observations add constraint reference_observations_kind_check check (kind in ('observed','interpreted'));

-- ---------- style / voice versions ----------
alter table public.style_bible_versions add column if not exists approved_at timestamptz;
alter table public.voice_guide_versions add column if not exists approved_at timestamptz;
-- at most one approved version per profile
create unique index if not exists style_bible_one_approved on public.style_bible_versions (profile_id) where status = 'approved';
create unique index if not exists voice_guide_one_approved on public.voice_guide_versions (profile_id) where status = 'approved';

-- ---------- concepts / scripts lineage ----------
alter table public.concepts
  add column if not exists brief_id uuid references public.briefs(id) on delete cascade,
  add column if not exists agent_run_id uuid references public.agent_runs(id) on delete set null,
  add column if not exists position smallint,
  add column if not exists mock boolean not null default false;

alter table public.scripts
  add column if not exists project_id uuid references public.projects(id) on delete cascade,
  add column if not exists parent_id uuid references public.scripts(id) on delete set null,
  add column if not exists source text not null default 'agent' check (source in ('agent','user_edit')),
  add column if not exists agent_run_id uuid references public.agent_runs(id) on delete set null,
  add column if not exists prompt_version text,
  add column if not exists style_version_id uuid references public.style_bible_versions(id),
  add column if not exists voice_version_id uuid references public.voice_guide_versions(id),
  add column if not exists mock boolean not null default false,
  add column if not exists approved_at timestamptz;

-- Hooks are first-class for analytics grouping (variants per script version).
create table if not exists public.hooks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  script_id uuid not null references public.scripts(id) on delete cascade,
  text text not null,
  selected boolean not null default false,
  created_at timestamptz not null default now()
);

-- ---------- publications / metrics lineage ----------
alter table public.publications
  add column if not exists title text not null default '',
  add column if not exists format text not null default 'reel' check (format in ('reel','carousel','photo','story')),
  add column if not exists permalink text not null default '',
  add column if not exists concept_id uuid references public.concepts(id) on delete set null,
  add column if not exists script_id uuid references public.scripts(id) on delete set null,
  add column if not exists hook_id uuid references public.hooks(id) on delete set null,
  add column if not exists hook_text text not null default '',
  add column if not exists style_version_id uuid references public.style_bible_versions(id),
  add column if not exists voice_version_id uuid references public.voice_guide_versions(id);

alter table public.metric_snapshots
  add column if not exists measurement_window text not null default '7d' check (measurement_window in ('24h','7d','30d'));

alter table public.agent_runs add column if not exists usage jsonb;
alter table public.workflow_jobs add column if not exists result jsonb, add column if not exists updated_at timestamptz not null default now();

-- ---------- RLS for new tables ----------
do $$
declare t text;
begin
  foreach t in array array['reference_keyframes','reference_analyses','hooks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- private storage bucket: <owner_id>/<path> ----------
insert into storage.buckets (id, name, public) values ('creative-media', 'creative-media', false)
  on conflict (id) do update set public = false;

create policy creative_media_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'creative-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy creative_media_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'creative-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy creative_media_owner_update on storage.objects for update to authenticated
  using (bucket_id = 'creative-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy creative_media_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'creative-media' and (storage.foldername(name))[1] = auth.uid()::text);

create index if not exists publications_lineage_idx on public.publications (owner_id, script_id, style_version_id);
create index if not exists scripts_concept_idx on public.scripts (owner_id, concept_id, version desc);
