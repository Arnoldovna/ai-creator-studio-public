-- AI Creator Studio — Etappe 17: CapCut/finish package and the QA „fehlende Wörter“. Mirrors `Render.finish` in
-- apps/web/src/server/store.ts.
--
-- renders.finish (jsonb, optional): the files of the finish package of one render – `clean` (video without burned text,
-- AI label kept), `clean_noimg` (also without image overlays), `alpha` (text layer with transparency), `cover` (still with
-- the hook) – each with storage path, size and SHA-256, plus the last QA result (findings with output times). The ZIP
-- itself is built per request and never stored. Rows stay owner-bound through the existing RLS policy of renders.
-- Workflow job kinds `finish` / `render_qa` need no change (workflow_jobs.workflow_name has no list).
--
-- STATUS: see docs/IMPLEMENTATION_LOG.md (Etappe 17) for where this was applied and tested.

alter table public.renders add column finish jsonb check (
  finish is null or coalesce(
    jsonb_typeof(finish) = 'object'
    and jsonb_typeof(finish -> 'files') = 'object'
    -- only the four known files, each with a string path and a non-negative size
    and not jsonb_path_exists(finish, '$.files.keyvalue() ? (!(@.key == "clean" || @.key == "clean_noimg" || @.key == "alpha" || @.key == "cover"))')
    and not jsonb_path_exists(finish, '$.files.* ? (!(@.storagePath.type() == "string" && @.size.type() == "number" && @.size >= 0))')
    -- the QA result: absent/null or an object with at most 200 findings
    and (coalesce(jsonb_typeof(finish -> 'qa'), 'null') = 'null'
      or (jsonb_typeof(finish -> 'qa') = 'object' and jsonb_typeof(finish -> 'qa' -> 'findings') = 'array' and jsonb_array_length(finish -> 'qa' -> 'findings') <= 200)),
    false)
);
