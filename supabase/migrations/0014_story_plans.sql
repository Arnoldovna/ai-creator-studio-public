-- AI Creator Studio — Etappe 16 (E8, E9): KI-Dramaturgie and image overlays. Mirrors `StoryPlanRecord` and
-- `Reference.usage` in apps/web/src/server/store.ts.
--
-- 1) story_plans: one Edit Director proposal for a draft (beats, hook options, overlays, images as jsonb `body`). Kept
--    apart from edit_drafts.body on purpose: a proposal is not draft content (the autosave would overwrite it, the
--    immutable render snapshot must not carry suggestions) and several proposals per draft are kept. `sources` pins the
--    transcript versions its sentences come from (a newer transcript = stale, checked in the app). Owner-bound, RLS,
--    goes with its project; the draft reference is cleared when the draft goes.
-- 2) chat_messages: proposals may also be of kind `story` (a change to the latest proposal, applied to the draft).
-- 3) references.usage: whether her library image may appear IN a video (own / licensed with source / generated =
--    labelled). Absent = only inspiration.
-- Image overlays themselves live in the existing edit_plans/edit_drafts jsonb bodies (`clips[].images`, optional).
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 16) for where this was applied and tested.

create table public.story_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  script_id uuid,
  draft_id uuid,
  draft_revision integer not null check (draft_revision >= 1),
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  agent_run_id uuid,
  prompt_version text not null check (length(prompt_version) <= 100),
  mock boolean not null default false,
  provider text not null check (length(provider) <= 40),
  model text not null check (length(model) <= 200),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cost_source text check (cost_source is null or cost_source in ('reported', 'tokens', 'worst_case', 'none')),
  -- coalesce: a missing key gives NULL, which a check would let through
  body jsonb not null check (coalesce(
    jsonb_typeof(body) = 'object' and jsonb_typeof(body -> 'beats') = 'array' and jsonb_typeof(body -> 'hooks') = 'array'
    and jsonb_typeof(body -> 'sentences') = 'array' and jsonb_array_length(body -> 'hooks') <= 6 and jsonb_array_length(body -> 'beats') <= 12, false)
  ),
  last_selection jsonb check (last_selection is null or jsonb_typeof(last_selection) = 'object'),
  applied jsonb not null default '[]' check (jsonb_typeof(applied) = 'array' and jsonb_array_length(applied) <= 10),
  created_at timestamptz not null default now(),
  constraint story_plans_owner_id_key unique (owner_id, id),
  constraint story_plans_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  constraint story_plans_script_fk foreign key (owner_id, script_id) references public.scripts (owner_id, id) on delete cascade,
  constraint story_plans_draft_fk foreign key (owner_id, draft_id) references public.edit_drafts (owner_id, id) on delete set null (draft_id),
  constraint story_plans_agent_run_fk foreign key (owner_id, agent_run_id) references public.agent_runs (owner_id, id) on delete set null (agent_run_id)
);
create index story_plans_project_idx on public.story_plans (owner_id, project_id, created_at desc);

alter table public.story_plans enable row level security;
create policy owner_all on public.story_plans for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.chat_messages drop constraint chat_messages_proposal_kinds;
alter table public.chat_messages add constraint chat_messages_proposal_kinds check (not jsonb_path_exists(proposals,
  '$[*] ? (!(@.kind.type() == "string" && (@.kind == "design" || @.kind == "strategy" || @.kind == "profile" || @.kind == "voice" || @.kind == "edit_draft" || @.kind == "story")))'));

alter table public.references add column usage jsonb check (
  usage is null or coalesce(
    jsonb_typeof(usage) = 'object' and (usage ->> 'origin') in ('own', 'licensed', 'generated')
    and ((usage ->> 'origin') <> 'licensed' or length(coalesce(usage ->> 'source', '')) >= 3), false)
);
