-- AI Creator Studio — Etappe 15 (E5, E9): the studio chat. Mirrors `ChatThread` and `ChatMessage` in
-- apps/web/src/server/store.ts (the plan's 0011 slot went to `fonts`, the chat is 0013).
--
-- 1) chat_threads: one history per page scope (`brand`, `strategy`, `general`, `editor:<project_id>`). An editor thread
--    belongs to its project and goes with it.
-- 2) chat_messages: her messages (text + up to four reference images) and the answers of one agent run each, with the
--    proposals as typed patches (jsonb). Proposals are only applied by her click in the app; there is no patch kind for
--    renders, paid jobs or posting, and the database refuses unknown kinds/statuses as well.
-- 3) context_versions.source gets `chat` (a strategy/profile version she took over from a chat proposal).
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 15) for where this was applied and tested.

create table public.chat_threads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope ~ '^(brand|strategy|general|editor:[0-9a-f-]{36})$'),
  project_id uuid,
  title text not null default '' check (length(title) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_threads_owner_id_key unique (owner_id, id),
  constraint chat_threads_project_fk foreign key (owner_id, project_id) references public.projects (owner_id, id) on delete cascade,
  -- only an editor thread has a project, and it is the project of its scope
  constraint chat_threads_scope_project check (
    (scope like 'editor:%') = (project_id is not null) and (project_id is null or scope = 'editor:' || project_id::text)
  )
);
create index chat_threads_scope_idx on public.chat_threads (owner_id, scope, updated_at desc);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  thread_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  body text not null check (length(body) between 1 and 8000),
  image_ids uuid[] not null default '{}' check (cardinality(image_ids) <= 4),
  agent_run_id uuid,
  mock boolean not null default false,
  provider text check (provider is null or length(provider) <= 40),
  model text check (model is null or length(model) <= 200),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  cost_source text check (cost_source is null or cost_source in ('reported', 'tokens', 'worst_case', 'none')),
  proposals jsonb not null default '[]' check (jsonb_typeof(proposals) = 'array' and jsonb_array_length(proposals) <= 3),
  warnings jsonb not null default '[]' check (jsonb_typeof(warnings) = 'array'),
  lint jsonb not null default '[]' check (jsonb_typeof(lint) = 'array'),
  created_at timestamptz not null default now(),
  constraint chat_messages_owner_id_key unique (owner_id, id),
  constraint chat_messages_thread_fk foreign key (owner_id, thread_id) references public.chat_threads (owner_id, id) on delete cascade,
  constraint chat_messages_agent_run_fk foreign key (owner_id, agent_run_id) references public.agent_runs (owner_id, id) on delete set null (agent_run_id),
  -- her message has no run and no proposals; only her message carries images
  constraint chat_messages_role_fields check (role = 'assistant' or (agent_run_id is null and jsonb_array_length(proposals) = 0)),
  constraint chat_messages_user_images check (role = 'user' or cardinality(image_ids) = 0),
  -- every proposal is one of the typed patch kinds with a known status (a string: a number or object compares as
  -- „unknown“ in jsonpath and would otherwise slip through)
  constraint chat_messages_proposal_kinds check (not jsonb_path_exists(proposals,
    '$[*] ? (!(@.kind.type() == "string" && (@.kind == "design" || @.kind == "strategy" || @.kind == "profile" || @.kind == "voice" || @.kind == "edit_draft")))')),
  constraint chat_messages_proposal_status check (not jsonb_path_exists(proposals,
    '$[*] ? (!(@.status.type() == "string" && (@.status == "open" || @.status == "applied" || @.status == "dismissed")))'))
);
create index chat_messages_thread_idx on public.chat_messages (owner_id, thread_id, created_at);

alter table public.chat_threads enable row level security;
alter table public.chat_messages enable row level security;
create policy owner_all on public.chat_threads for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy owner_all on public.chat_messages for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.context_versions drop constraint context_versions_source_check;
alter table public.context_versions add constraint context_versions_source_check
  check (source in ('import', 'manual', 'copy', 'defaults', 'import_bundle', 'migration', 'chat'));
