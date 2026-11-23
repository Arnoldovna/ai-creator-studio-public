-- AI Creator Studio — Etappe 18: Karussell-Generator. Mirrors `CarouselRecord` and `CarouselVersion` in
-- apps/web/src/server/store.ts.
--
-- 1) carousels: one carousel per idea, with where the idea came from (concept, script, a finished reel's transcript, her
--    note). Owner-bound, RLS, goes with its project. The source row may go later (the carousel keeps its label and text).
-- 2) carousel_versions: every edit, variant (same texts, other layout/look) and chat change is a NEW version; exactly one is
--    active per carousel. `body` = slides (2–10), format, template, caption (jsonb, validated in the app with Zod; the
--    database checks the shape). Lineage to the style/voice/strategy/profile versions the text was written with; the agent
--    run of a generated version. `render` = the files of its last PNG render (content-addressed storage paths).
-- 3) chat: a thread may belong to a carousel (`carousel:<id>`, with the carousel's project), proposals may be of kind
--    `carousel` (applied as a new version by her click in the app).
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 18) for where this was applied and tested.

create table public.carousels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  title text not null check (length(title) between 1 and 120),
  source_kind text not null check (source_kind in ('concept', 'script', 'render', 'note')),
  source_concept_id uuid,
  source_script_id uuid,
  source_render_id uuid,
  source_label text not null check (length(source_label) <= 200),
  source_text text not null default '' check (length(source_text) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint carousels_owner_id_key unique (owner_id, id),
  constraint carousels_owner_project_key unique (owner_id, id, project_id),
  constraint carousels_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint carousels_concept_fk foreign key (owner_id, source_concept_id) references public.concepts (owner_id, id) on delete set null (source_concept_id),
  constraint carousels_script_fk foreign key (owner_id, source_script_id) references public.scripts (owner_id, id) on delete set null (source_script_id),
  constraint carousels_render_fk foreign key (owner_id, source_render_id) references public.renders (owner_id, id) on delete set null (source_render_id),
  -- at most the source of its kind is set (a deleted source leaves the label and text)
  constraint carousels_source_ref check (
    (source_concept_id is null or source_kind = 'concept') and (source_script_id is null or source_kind = 'script')
    and (source_render_id is null or source_kind = 'render')
  )
);
create index carousels_project_idx on public.carousels (owner_id, project_id, updated_at desc);

create table public.carousel_versions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  carousel_id uuid not null,
  version integer not null check (version >= 1),
  parent_id uuid,
  status text not null check (status in ('active', 'archived')),
  origin text not null check (origin in ('agent', 'user_edit', 'variant', 'chat')),
  -- coalesce: a missing key gives NULL, which a check would let through
  body jsonb not null check (coalesce(
    jsonb_typeof(body) = 'object' and jsonb_typeof(body -> 'slides') = 'array'
    and jsonb_array_length(body -> 'slides') between 2 and 10
    and (body ->> 'format') in ('portrait', 'square')
    and (body ->> 'templateId') in ('klar', 'kontrast', 'rahmen', 'karte', 'editorial')
    and jsonb_typeof(body -> 'caption') = 'string' and length(body ->> 'caption') <= 2200
    and not jsonb_path_exists(body, '$.slides[*] ? (!(@.kind.type() == "string" && (@.kind == "title" || @.kind == "text" || @.kind == "list" || @.kind == "quote" || @.kind == "image_text" || @.kind == "before_after" || @.kind == "cta")))'),
    false)),
  agent_run_id uuid,
  prompt_version text check (prompt_version is null or length(prompt_version) <= 100),
  mock boolean not null default false,
  provider text check (provider is null or length(provider) <= 40),
  model text check (model is null or length(model) <= 200),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cost_source text check (cost_source is null or cost_source in ('reported', 'tokens', 'worst_case', 'none')),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array' and jsonb_array_length(warnings) <= 40),
  style_bible_version_id uuid,
  voice_guide_version_id uuid,
  strategy_version_id uuid,
  profile_version_id uuid,
  render jsonb check (render is null or coalesce(jsonb_typeof(render) = 'object' and jsonb_typeof(render -> 'files') = 'array' and jsonb_array_length(render -> 'files') <= 10, false)),
  created_at timestamptz not null default now(),
  constraint carousel_versions_owner_id_key unique (owner_id, id),
  constraint carousel_versions_number_key unique (carousel_id, version),
  constraint carousel_versions_carousel_fk foreign key (owner_id, carousel_id) references public.carousels (owner_id, id) on delete cascade,
  constraint carousel_versions_parent_fk foreign key (owner_id, parent_id) references public.carousel_versions (owner_id, id) on delete set null (parent_id),
  constraint carousel_versions_agent_run_fk foreign key (owner_id, agent_run_id) references public.agent_runs (owner_id, id) on delete set null (agent_run_id),
  constraint carousel_versions_style_fk foreign key (owner_id, style_bible_version_id) references public.style_bible_versions (owner_id, id) on delete set null (style_bible_version_id),
  constraint carousel_versions_voice_fk foreign key (owner_id, voice_guide_version_id) references public.voice_guide_versions (owner_id, id) on delete set null (voice_guide_version_id),
  constraint carousel_versions_strategy_fk foreign key (owner_id, strategy_version_id) references public.context_versions (owner_id, id) on delete set null (strategy_version_id),
  constraint carousel_versions_profile_fk foreign key (owner_id, profile_version_id) references public.context_versions (owner_id, id) on delete set null (profile_version_id),
  -- a generated version names its run and prompt; an edit/variant/chat version has none
  constraint carousel_versions_agent_fields check ((origin = 'agent') = (prompt_version is not null))
);
-- exactly one active version per carousel (the app archives the previous one in the same write)
create unique index carousel_versions_one_active on public.carousel_versions (carousel_id) where status = 'active';

alter table public.carousels enable row level security;
alter table public.carousel_versions enable row level security;
create policy owner_all on public.carousels for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy owner_all on public.carousel_versions for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- chat: carousel threads (with the carousel's project, deleted with it) and proposals of kind `carousel`
alter table public.chat_threads drop constraint chat_threads_scope_check;
alter table public.chat_threads add constraint chat_threads_scope_check check (scope ~ '^(brand|strategy|general|editor:[0-9a-f-]{36}|carousel:[0-9a-f-]{36})$');
alter table public.chat_threads add column carousel_id uuid;
-- the thread's project is the carousel's project
alter table public.chat_threads add constraint chat_threads_carousel_fk foreign key (owner_id, carousel_id, project_id) references public.carousels (owner_id, id, project_id) on delete cascade;
alter table public.chat_threads drop constraint chat_threads_scope_project;
alter table public.chat_threads add constraint chat_threads_scope_project check (
  case
    when scope like 'editor:%' then project_id is not null and carousel_id is null and scope = 'editor:' || project_id::text
    when scope like 'carousel:%' then project_id is not null and carousel_id is not null and scope = 'carousel:' || carousel_id::text
    else project_id is null and carousel_id is null
  end
);
alter table public.chat_messages drop constraint chat_messages_proposal_kinds;
alter table public.chat_messages add constraint chat_messages_proposal_kinds check (not jsonb_path_exists(proposals,
  '$[*] ? (!(@.kind.type() == "string" && (@.kind == "design" || @.kind == "strategy" || @.kind == "profile" || @.kind == "voice" || @.kind == "edit_draft" || @.kind == "story" || @.kind == "carousel")))'));
