-- AI Creator Studio — Etappe 14: „Meine Marke“ (design system) and her own font files.
-- Mirrors `FontRecord` in apps/web/src/server/store.ts. The design system itself lives in the existing
-- `style_bible_versions.rules` jsonb (`rules.design`, optional and additive, E4): no new column for it.
-- Upload rules enforced by the app (core `parseFontFile`): TTF/OTF by magic bytes, ≤ 10 MB, upright faces only,
-- a licence note is required; the file lives in the private bucket under `<owner_id>/fonts/<id>.<ext>`.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 14) for where this was applied and tested.

create table public.fonts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  profile_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  format text not null check (format in ('ttf', 'otf')),
  family text not null check (length(family) between 1 and 60),
  -- names libass and the ASS style line take safely (no commas, braces or quotes)
  postscript_name text not null check (length(postscript_name) between 1 and 63),
  ass_name text not null check (ass_name ~ '^[A-Za-z0-9 _-]{1,63}$'),
  weight integer not null check (weight between 1 and 1000),
  italic boolean not null default false check (italic = false),
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null check (storage_path ~ '^fonts/[0-9a-f-]{36}\.(ttf|otf)$'),
  license text not null check (length(btrim(license)) between 3 and 500),
  created_at timestamptz not null default now(),
  constraint fonts_owner_id_key unique (owner_id, id),
  constraint fonts_sha256_key unique (owner_id, sha256),
  constraint fonts_postscript_name_key unique (owner_id, postscript_name),
  constraint fonts_storage_path_key unique (owner_id, storage_path),
  constraint fonts_profile_id_owner_fkey foreign key (owner_id, profile_id) references public.creative_profiles (owner_id, id) on delete cascade
);
create index on public.fonts (owner_id, family);

alter table public.fonts enable row level security;
create policy owner_all on public.fonts for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
