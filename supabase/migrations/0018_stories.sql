-- AI Creator Studio — Etappe 19: Instagram-Stories. Mirrors `IgStoryRecord` in apps/web/src/server/store.ts (core schema
-- `IgStoryBody` in packages/core/src/igStory.ts).
--
-- stories: one 9:16 story from material she has (a finished reel, a carousel, a concept, a library photo, her note).
-- Owner-bound, RLS, goes with its project; the source row may go later (label and text stay). `body` = kind, media, texts,
-- sticker NOTE (the studio cannot place Instagram stickers), checked for its shape here and with Zod in the app. A clip is
-- at most 15 s. `revision` counts her saves (a save on an older revision is refused in the app). Stories of one Story
-- Writer run share `batch_id`; a generated story names its run and prompt. `render` = the file of its last PNG/MP4 render.
-- Nothing here posts anything.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 19) for where this was applied and tested.

create table public.stories (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  batch_id uuid not null,
  title text not null check (length(title) between 1 and 120),
  source_kind text not null check (source_kind in ('render', 'carousel', 'concept', 'note', 'image')),
  source_render_id uuid,
  source_carousel_id uuid,
  source_concept_id uuid,
  source_reference_id uuid,
  source_label text not null check (length(source_label) <= 200),
  source_text text not null default '' check (length(source_text) <= 8000),
  revision integer not null default 1 check (revision >= 1),
  -- coalesce: a missing key gives NULL, which a check would let through
  body jsonb not null check (coalesce(
    jsonb_typeof(body) = 'object'
    and (body ->> 'kind') in ('teaser', 'bts', 'question', 'quote', 'progress')
    and jsonb_typeof(body -> 'media') = 'object'
    and (body -> 'media' ->> 'kind') in ('none', 'image', 'carousel_slide', 'frame', 'clip')
    and ((body -> 'media' ->> 'kind') <> 'clip' or (jsonb_typeof(body -> 'media' -> 'durationSec') = 'number' and (body -> 'media' ->> 'durationSec')::numeric between 1 and 15))
    and jsonb_typeof(body -> 'title') = 'string' and length(body ->> 'title') <= 140
    and jsonb_typeof(body -> 'kicker') = 'string' and length(body ->> 'kicker') <= 40
    and jsonb_typeof(body -> 'body') = 'string' and length(body ->> 'body') <= 240
    and (body -> 'sticker' ->> 'kind') in ('none', 'poll', 'question', 'quiz', 'slider', 'link'),
    false)),
  origin text not null check (origin in ('agent', 'manual')),
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
  render jsonb check (render is null or coalesce(jsonb_typeof(render) = 'object' and jsonb_typeof(render -> 'storagePath') = 'string'
    and (render ->> 'mime') in ('image/png', 'video/mp4'), false)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stories_owner_id_key unique (owner_id, id),
  constraint stories_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint stories_render_fk foreign key (owner_id, source_render_id) references public.renders (owner_id, id) on delete set null (source_render_id),
  constraint stories_carousel_fk foreign key (owner_id, source_carousel_id) references public.carousels (owner_id, id) on delete set null (source_carousel_id),
  constraint stories_concept_fk foreign key (owner_id, source_concept_id) references public.concepts (owner_id, id) on delete set null (source_concept_id),
  constraint stories_reference_fk foreign key (owner_id, source_reference_id) references public.references (owner_id, id) on delete set null (source_reference_id),
  constraint stories_agent_run_fk foreign key (owner_id, agent_run_id) references public.agent_runs (owner_id, id) on delete set null (agent_run_id),
  constraint stories_style_fk foreign key (owner_id, style_bible_version_id) references public.style_bible_versions (owner_id, id) on delete set null (style_bible_version_id),
  constraint stories_voice_fk foreign key (owner_id, voice_guide_version_id) references public.voice_guide_versions (owner_id, id) on delete set null (voice_guide_version_id),
  constraint stories_strategy_fk foreign key (owner_id, strategy_version_id) references public.context_versions (owner_id, id) on delete set null (strategy_version_id),
  constraint stories_profile_fk foreign key (owner_id, profile_version_id) references public.context_versions (owner_id, id) on delete set null (profile_version_id),
  -- at most the source of its kind is set (a deleted source leaves the label and text)
  constraint stories_source_ref check (
    (source_render_id is null or source_kind = 'render') and (source_carousel_id is null or source_kind = 'carousel')
    and (source_concept_id is null or source_kind = 'concept') and (source_reference_id is null or source_kind = 'image')
  ),
  -- a generated story names its prompt; her own story has none
  constraint stories_agent_fields check ((origin = 'agent') = (prompt_version is not null))
);
create index stories_project_idx on public.stories (owner_id, project_id, created_at desc);
create index stories_batch_idx on public.stories (owner_id, batch_id);

alter table public.stories enable row level security;
create policy owner_all on public.stories for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
