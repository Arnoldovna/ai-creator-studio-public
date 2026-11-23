-- AI Creator Studio — Etappe 16b: font library (installed Mac fonts, Google Fonts, word-by-word subtitles, fade/pop).
-- Mirrors `FontRecord.origin` in apps/web/src/server/store.ts.
--
-- fonts: where a file comes from. `upload` (her own file, Etappe 14, the default for every existing row) or `google`
-- (added from Google Fonts): then the family, the weight, the versioned HTTPS file URL on fonts.gstatic.com it was
-- downloaded from (its SHA-256 is the existing `sha256`), the recognised licence (OFL/Apache/UFL, read from the file) and
-- its URL are required. Mac fonts are never stored (they stay on the Mac; type roles and cut elements name them as
-- `mac:<PostScriptName>` inside the existing jsonb of style_bible_versions.rules / edit_plans / edit_drafts).
-- Text animations and the subtitle mode are optional fields in the same jsonb bodies: no schema change.
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 16b) for where this was applied and tested.

alter table public.fonts
  add column origin_kind text not null default 'upload' check (origin_kind in ('upload', 'google')),
  add column google_family text check (google_family is null or google_family ~ '^[A-Za-z0-9 ]{1,60}$'),
  add column source_url text check (source_url is null or (length(source_url) <= 500 and source_url ~ '^https://fonts\.gstatic\.com/s/[a-z0-9]+/v[0-9]+/[A-Za-z0-9._-]+\.(ttf|otf)$')),
  add column license_id text check (license_id is null or license_id in ('OFL-1.1', 'Apache-2.0', 'UFL-1.0')),
  add column license_url text check (license_url is null or (length(license_url) <= 300 and license_url ~ '^https://')),
  add constraint fonts_google_origin_check check (
    origin_kind = 'upload' and google_family is null and source_url is null and license_id is null
    or origin_kind = 'google' and google_family is not null and source_url is not null and license_id is not null and license_url is not null
  );
