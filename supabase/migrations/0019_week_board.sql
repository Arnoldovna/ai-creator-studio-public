-- AI Creator Studio — Etappe 20: Wochenboard. Mirrors `BoardItem` and `WeekPlanRecord` in apps/web/src/server/store.ts.
--
-- 1) board_items: a planned post (reel, carousel, idea) or a story on a day (`day` null = „ohne Tag“), optionally linked to
--    its material (at most one ref of the named kind; a deleted source leaves the entry with its title). Her status idea →
--    in progress → ready → posted; `posted_at`/`permalink` only with „posted“, set by her click. There is deliberately no
--    column for scheduling, reminders, alarms or automatic publishing: the studio never posts or reminds. The permalink is
--    an https link or empty. `publication_id` = the Rückblick record she made from it.
-- 2) week_plans: one „Woche füllen“ run (Week Planner) with its suggestions (each taken over by her click or not).
-- 3) chat: the board has its own chat history (`week`), proposals may be of kind `week`.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 20) for where this was applied and tested.

create table public.week_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  suggestions jsonb not null default '[]' check (coalesce(jsonb_typeof(suggestions) = 'array' and jsonb_array_length(suggestions) <= 28
    and not jsonb_path_exists(suggestions, '$[*] ? (!(@.kind.type() == "string" && (@.kind == "reel" || @.kind == "carousel" || @.kind == "story" || @.kind == "idea")))')
    and not jsonb_path_exists(suggestions, '$[*] ? (!(@.status.type() == "string" && (@.status == "open" || @.status == "accepted" || @.status == "dismissed")))'), false)),
  agent_run_id uuid,
  prompt_version text not null check (length(prompt_version) <= 100),
  mock boolean not null default false,
  provider text check (provider is null or length(provider) <= 40),
  model text check (model is null or length(model) <= 200),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cost_source text check (cost_source is null or cost_source in ('reported', 'tokens', 'worst_case', 'none')),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array' and jsonb_array_length(warnings) <= 40),
  notes text not null default '' check (length(notes) <= 600),
  created_at timestamptz not null default now(),
  constraint week_plans_owner_id_key unique (owner_id, id),
  constraint week_plans_agent_run_fk foreign key (owner_id, agent_run_id) references public.agent_runs (owner_id, id) on delete set null (agent_run_id)
);
create index week_plans_week_idx on public.week_plans (owner_id, week_start, created_at desc);

create table public.board_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  day date,
  slot text not null check (slot in ('main', 'story')),
  kind text not null check (kind in ('reel', 'carousel', 'story', 'idea')),
  ord integer not null default 0 check (ord >= 0),
  title text not null check (length(title) between 1 and 140),
  note text not null default '' check (length(note) <= 1000),
  pillar_id text check (pillar_id is null or pillar_id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  status text not null check (status in ('idea', 'in_progress', 'ready', 'posted')),
  ref_kind text check (ref_kind is null or ref_kind in ('render', 'edit_draft', 'carousel', 'story', 'concept')),
  ref_render_id uuid,
  ref_edit_draft_id uuid,
  ref_carousel_id uuid,
  ref_story_id uuid,
  ref_concept_id uuid,
  posted_at date,
  permalink text not null default '' check (permalink = '' or (length(permalink) <= 500 and permalink ~ '^https://[^[:space:]<>"'']+$')),
  publication_id uuid,
  origin text not null check (origin in ('manual', 'planner')),
  plan_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint board_items_owner_id_key unique (owner_id, id),
  constraint board_items_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete set null (project_id),
  constraint board_items_render_fk foreign key (owner_id, ref_render_id) references public.renders (owner_id, id) on delete set null (ref_render_id),
  constraint board_items_edit_draft_fk foreign key (owner_id, ref_edit_draft_id) references public.edit_drafts (owner_id, id) on delete set null (ref_edit_draft_id),
  constraint board_items_carousel_fk foreign key (owner_id, ref_carousel_id) references public.carousels (owner_id, id) on delete set null (ref_carousel_id),
  constraint board_items_story_fk foreign key (owner_id, ref_story_id) references public.stories (owner_id, id) on delete set null (ref_story_id),
  constraint board_items_concept_fk foreign key (owner_id, ref_concept_id) references public.concepts (owner_id, id) on delete set null (ref_concept_id),
  constraint board_items_publication_fk foreign key (owner_id, publication_id) references public.publications (owner_id, id) on delete set null (publication_id),
  constraint board_items_plan_fk foreign key (owner_id, plan_id) references public.week_plans (owner_id, id) on delete set null (plan_id),
  -- a story sits in the story slot, everything else is a main post
  constraint board_items_slot_kind check ((kind = 'story') = (slot = 'story')),
  -- at most the ref of the named kind (a deleted source nulls its column; the kind may then stay without an id)
  constraint board_items_ref check (
    (ref_render_id is null or ref_kind = 'render') and (ref_edit_draft_id is null or ref_kind = 'edit_draft')
    and (ref_carousel_id is null or ref_kind = 'carousel') and (ref_story_id is null or ref_kind = 'story') and (ref_concept_id is null or ref_kind = 'concept')
  ),
  -- „gepostet“ (date, link, Rückblick record) only together with the status she set
  constraint board_items_posted check ((status = 'posted') = (posted_at is not null) and (status = 'posted' or (permalink = '' and publication_id is null)))
);
create index board_items_day_idx on public.board_items (owner_id, day, slot, ord);

alter table public.week_plans enable row level security;
alter table public.board_items enable row level security;
create policy owner_all on public.week_plans for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy owner_all on public.board_items for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- chat: the board's own history (`week`, no project) and proposals of kind `week` (moves, applied by her click)
alter table public.chat_threads drop constraint chat_threads_scope_check;
alter table public.chat_threads add constraint chat_threads_scope_check check (scope ~ '^(brand|strategy|general|week|editor:[0-9a-f-]{36}|carousel:[0-9a-f-]{36})$');
alter table public.chat_messages drop constraint chat_messages_proposal_kinds;
alter table public.chat_messages add constraint chat_messages_proposal_kinds check (not jsonb_path_exists(proposals,
  '$[*] ? (!(@.kind.type() == "string" && (@.kind == "design" || @.kind == "strategy" || @.kind == "profile" || @.kind == "voice" || @.kind == "edit_draft" || @.kind == "story" || @.kind == "carousel" || @.kind == "week")))'));
