-- AI Creator Studio — owner-bound foreign keys.
--
-- Why: RLS policies only check `owner_id` of the row being written. Foreign-key checks run
-- without RLS, so an authenticated user could attach their own rows to another user's
-- parent rows (e.g. a project on someone else's profile). Found by
-- supabase/tests/database/rls.test.sql against a real local Supabase stack.
--
-- Fix: every public→public FK becomes a composite FK (owner_id, <col>) → (owner_id, id),
-- so parent and child must belong to the same owner. `on delete set null` only nulls the
-- reference column (Postgres ≥ 15 column list), never owner_id.
--
-- STATUS: Applied to a local Supabase stack (CLI 3.1.0, Postgres 17.11) via `supabase db reset` and checked by `pnpm test:db` (pgTAP); also tested against PGlite. NOT yet applied to a hosted Supabase project.

-- 1) every referenced table needs a unique (owner_id, id) key
do $$
declare t text;
begin
  foreach t in array array[
    'creative_profiles','references','reference_observations','style_bible_versions',
    'voice_guide_versions','projects','briefs','research_reports','concepts','scripts',
    'assets','edit_plans','renders','publications','metric_snapshots','growth_insights',
    'experiments','agent_runs','workflow_jobs','reference_keyframes','reference_analyses','hooks'
  ] loop
    execute format('alter table public.%I add constraint %I unique (owner_id, id)', t, t || '_owner_id_key');
  end loop;
end $$;

-- 2) replace single-column FKs with owner-bound composite FKs
do $$
declare r record; old_name text;
begin
  for r in select * from (values
    ('references', 'profile_id', 'creative_profiles', 'cascade'),
    ('agent_runs', 'project_id', 'projects', 'cascade'),
    ('assets', 'project_id', 'projects', 'cascade'),
    ('briefs', 'project_id', 'projects', 'cascade'),
    ('concepts', 'agent_run_id', 'agent_runs', 'set null'),
    ('concepts', 'brief_id', 'briefs', 'cascade'),
    ('concepts', 'project_id', 'projects', 'cascade'),
    ('concepts', 'style_version_id', 'style_bible_versions', 'no action'),
    ('concepts', 'voice_version_id', 'voice_guide_versions', 'no action'),
    ('edit_plans', 'project_id', 'projects', 'cascade'),
    ('edit_plans', 'script_id', 'scripts', 'set null'),
    ('experiments', 'insight_id', 'growth_insights', 'no action'),
    ('experiments', 'profile_id', 'creative_profiles', 'cascade'),
    ('growth_insights', 'profile_id', 'creative_profiles', 'cascade'),
    ('hooks', 'script_id', 'scripts', 'cascade'),
    ('metric_snapshots', 'publication_id', 'publications', 'cascade'),
    ('projects', 'profile_id', 'creative_profiles', 'restrict'),
    ('projects', 'style_version_id', 'style_bible_versions', 'no action'),
    ('projects', 'voice_version_id', 'voice_guide_versions', 'no action'),
    ('publications', 'concept_id', 'concepts', 'set null'),
    ('publications', 'hook_id', 'hooks', 'set null'),
    ('publications', 'project_id', 'projects', 'cascade'),
    ('publications', 'render_id', 'renders', 'no action'),
    ('publications', 'script_id', 'scripts', 'set null'),
    ('publications', 'style_version_id', 'style_bible_versions', 'no action'),
    ('publications', 'voice_version_id', 'voice_guide_versions', 'no action'),
    ('reference_analyses', 'agent_run_id', 'agent_runs', 'set null'),
    ('reference_analyses', 'reference_id', 'references', 'cascade'),
    ('reference_keyframes', 'reference_id', 'references', 'cascade'),
    ('reference_observations', 'analysis_id', 'reference_analyses', 'cascade'),
    ('reference_observations', 'reference_id', 'references', 'cascade'),
    ('renders', 'edit_plan_id', 'edit_plans', 'cascade'),
    ('renders', 'output_asset_id', 'assets', 'no action'),
    ('research_reports', 'project_id', 'projects', 'cascade'),
    ('scripts', 'agent_run_id', 'agent_runs', 'set null'),
    ('scripts', 'concept_id', 'concepts', 'cascade'),
    ('scripts', 'parent_id', 'scripts', 'set null'),
    ('scripts', 'project_id', 'projects', 'cascade'),
    ('scripts', 'style_version_id', 'style_bible_versions', 'no action'),
    ('scripts', 'voice_version_id', 'voice_guide_versions', 'no action'),
    ('style_bible_versions', 'profile_id', 'creative_profiles', 'cascade'),
    ('voice_guide_versions', 'profile_id', 'creative_profiles', 'cascade'),
    ('workflow_jobs', 'project_id', 'projects', 'cascade')
  ) as v(tbl, col, ref, on_delete) loop
    select c.conname into strict old_name
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.conrelid = format('public.%I', r.tbl)::regclass
       and array_length(c.conkey, 1) = 1 and a.attname = r.col;
    execute format('alter table public.%I drop constraint %I', r.tbl, old_name);
    execute format(
      'alter table public.%I add constraint %I foreign key (owner_id, %I) references public.%I (owner_id, id) on delete %s',
      r.tbl, r.tbl || '_' || r.col || '_owner_fkey', r.col, r.ref,
      case when r.on_delete = 'set null' then format('set null (%I)', r.col) else r.on_delete end);
  end loop;
end $$;
