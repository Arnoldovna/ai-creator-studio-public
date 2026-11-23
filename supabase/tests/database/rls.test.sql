-- pgTAP tests against the REAL local Supabase stack (`supabase test db`).
-- Checks owner isolation via RLS and the private storage bucket with real auth/storage schemas.
begin;
select plan(110);

insert into auth.users (id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'u1@test.invalid'),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'u2@test.invalid');
insert into public.creative_profiles (id, owner_id, name, profile_kind) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'A', 'personal'),
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'B', 'personal');

select ok((select public = false from storage.buckets where id = 'creative-media'), 'creative-media bucket is private');
select ok((select bool_and(rowsecurity) from pg_tables where schemaname = 'public'), 'RLS enabled on every public table');

-- anon sees nothing
set local role anon;
select is((select count(*)::int from public.creative_profiles), 0, 'anon sees no profiles');
reset role;

-- user 1
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select results_eq('select name from public.creative_profiles', $$values ('A'::text)$$, 'user 1 sees only own profile');
select throws_ok(
  $$insert into public.creative_profiles (owner_id, name, profile_kind) values ('22222222-2222-2222-2222-222222222222', 'X', 'personal')$$,
  '42501', null, 'user 1 cannot insert rows owned by user 2');
select lives_ok(
  $$insert into public.projects (owner_id, profile_id, project_kind, title) values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'UGC_CLIENT', 'K')$$,
  'user 1 can create a project on own profile');
select throws_ok(
  $$insert into public.projects (owner_id, profile_id, project_kind, title) values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'UGC_CLIENT', 'K2')$$,
  '23503', null, 'user 1 cannot attach a project to user 2''s profile (owner-bound FK)');
select lives_ok(
  $$insert into storage.objects (bucket_id, name, owner_id) values ('creative-media', '11111111-1111-1111-1111-111111111111/media/a.png', '11111111-1111-1111-1111-111111111111')$$,
  'user 1 can write into own storage folder');
select throws_ok(
  $$insert into storage.objects (bucket_id, name, owner_id) values ('creative-media', '22222222-2222-2222-2222-222222222222/media/b.png', '11111111-1111-1111-1111-111111111111')$$,
  '42501', null, 'user 1 cannot write into user 2''s storage folder');
reset role;

-- user 2
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from storage.objects where bucket_id = 'creative-media'), 0, 'user 2 cannot see user 1''s objects');
select is((select count(*)::int from public.projects), 0, 'user 2 cannot see user 1''s projects');
reset role;

-- composite FK with ON DELETE SET NULL (col) keeps owner_id intact
insert into public.agent_runs (id, owner_id, agent_name, prompt_version, model) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'reference_analyst', 'p@1', 'mock');
insert into public.references (id, owner_id, profile_id, media_kind) values
  ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'image');
insert into public.reference_analyses (owner_id, reference_id, agent_run_id, provider, model, prompt_version, analysis) values
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'mock', 'mock', 'p@1', '{}');
delete from public.agent_runs where id = 'bbbbbbbb-0000-0000-0000-000000000001';
select results_eq(
  $$select agent_run_id is null, owner_id::text from public.reference_analyses$$,
  $$values (true, '11111111-1111-1111-1111-111111111111'::text)$$,
  'deleting an agent run nulls only the reference column');
select throws_ok(
  $$insert into public.reference_analyses (owner_id, reference_id, provider, model, prompt_version, analysis) values ('22222222-2222-2222-2222-222222222222', 'cccccccc-0000-0000-0000-000000000001', 'mock', 'mock', 'p@1', '{}')$$,
  '23503', null, 'cross-owner reference is rejected even without RLS (service role)');

-- footage (0004): rights provenance, dedup per project, cross-owner project rejected
insert into public.projects (id, owner_id, profile_id, project_kind, title) values
  ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'PERSONAL_CONTENT', 'Footage');
select lives_ok(
  $$insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, origin, name, sha256, rights_confirmed_at) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'footage/a.mp4', 'video/mp4', 1, 'own', 'take1.mov', repeat('a', 64), now())$$,
  'own footage with confirmed rights is accepted');
select throws_ok(
  $$insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, origin, name, sha256, rights_confirmed_at) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'footage/b.mp4', 'video/mp4', 1, 'own', 'dup.mov', repeat('a', 64), now())$$,
  '23505', null, 'same content twice in one project is rejected');
select throws_ok(
  $$insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, origin, name, rights_confirmed_at) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'footage/c.mp4', 'video/mp4', 1, 'client', 'c.mov', now())$$,
  '23514', null, 'client footage without a source note is rejected');
select throws_ok(
  $$insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, origin, name) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'footage/d.mp4', 'video/mp4', 1, 'own', 'd.mov')$$,
  '23514', null, 'footage without confirmed rights is rejected');
select throws_ok(
  $$insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, origin, name, rights_confirmed_at) values ('22222222-2222-2222-2222-222222222222', 'dddddddd-0000-0000-0000-000000000001', 'footage/e.mp4', 'video/mp4', 1, 'own', 'e.mov', now())$$,
  '23503', null, 'footage cannot be attached to another owner''s project');

-- edit plans + renders (0005)
insert into public.edit_plans (id, owner_id, project_id, body, status, approved_at) values
  ('eeeeeeee-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{}', 'approved', now());
select throws_ok(
  $$insert into public.edit_plans (owner_id, project_id, body, parent_id) values ('22222222-2222-2222-2222-222222222222', 'dddddddd-0000-0000-0000-000000000001', '{}', 'eeeeeeee-0000-0000-0000-000000000001')$$,
  '23503', null, 'an EDL cannot be attached to another owner''s project or parent version');
select throws_ok(
  $$insert into public.renders (owner_id, edit_plan_id, status) values ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001', 'pending_review')$$,
  '23514', null, 'a render waiting for review must have its output file');
select lives_ok(
  $$insert into public.renders (owner_id, edit_plan_id) values ('11111111-1111-1111-1111-111111111111', 'eeeeeeee-0000-0000-0000-000000000001')$$,
  'a new render starts as rendering');
select throws_ok(
  $$insert into public.workflow_jobs (owner_id, workflow_name, idempotency_key, status) values ('11111111-1111-1111-1111-111111111111', 'render', 'key-0005-a', 'paused')$$,
  '23514', null, 'jobs only take the async states');

-- transcripts (0006)
select throws_ok(
  $$insert into public.transcripts (owner_id, project_id, asset_id, version, source, storage_path) select '22222222-2222-2222-2222-222222222222', 'dddddddd-0000-0000-0000-000000000001', id, 1, 'whisper', 't.json' from public.assets where owner_id = '11111111-1111-1111-1111-111111111111' limit 1$$,
  '23503', null, 'a transcript cannot be attached to another owner''s footage');
select throws_ok(
  $$insert into public.transcripts (owner_id, project_id, asset_id, version, source, storage_path) select '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', id, 2, 'user_edit', 't.json' from public.assets where owner_id = '11111111-1111-1111-1111-111111111111' limit 1$$,
  '23514', null, 'a correction needs the version it corrects');

-- generated B-roll (0007)
select throws_ok(
  $$insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, resolution, prompt, duration_sec, quoted_credits, status) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 0, 0, 'seedance_2_5', '720p', 'Wolle', 5, 25, 'queued')$$,
  '23514', null, 'a generation cannot leave `quoted` without a credit approval');
select throws_ok(
  $$insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, resolution, prompt, duration_sec, quoted_credits, status, approved_max_credits, approved_at) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 0, 0, 'seedance_2_5', '720p', 'Wolle', 5, 25, 'queued', 10, now())$$,
  '23514', null, 'the approval must cover the quote');
select lives_ok(
  $$insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, prompt, duration_sec, quoted_credits) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 0, 0, 'kling3_0', 'Wolle', 5, 25)$$,
  'user 1 can store a quote in an own project');
select throws_ok(
  $$insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, resolution, prompt, duration_sec, quoted_credits) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 0, 0, 'kling3_0', '1080p', 'Wolle', 5, 25)$$,
  '23514', null, 'Kling and Veo have no resolution param (only Seedance does)');
select throws_ok(
  $$insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, prompt, duration_sec, quoted_credits) values ('22222222-2222-2222-2222-222222222222', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 0, 0, 'kling3_0', 'Wolle', 5, 25)$$,
  '23503', null, 'a generation cannot be attached to another owner''s project');
select throws_ok(
  $$update public.projects set ai_broll_credit_budget = 100, ai_broll_opt_in_at = null where id = 'dddddddd-0000-0000-0000-000000000001'$$,
  '23514', null, 'a credit budget needs the project opt-in');

-- free cut, script FK, silence scans (0008)
insert into public.assets (id, owner_id, project_id, storage_path, mime_type, size_bytes, origin, name, sha256, rights_confirmed_at) values
  ('ffffffff-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'footage/scan.mp4', 'video/mp4', 1, 'own', 'scan.mov', repeat('b', 64), now());
select lives_ok(
  $$insert into public.silence_scans (owner_id, project_id, asset_id, params, ranges) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', '{"noiseDb": -38.5, "minSilenceSec": 0.15, "meanDb": -18.5}', '[{"startSec": 0.2, "endSec": 0.5}]')$$,
  'a silence scan can be stored for own footage');
select throws_ok(
  $$insert into public.silence_scans (owner_id, project_id, asset_id, params) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', '{}')$$,
  '23505', null, 'one silence scan per clip (a new scan replaces the old one)');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select is((select count(*)::int from public.silence_scans), 1, 'user 1 sees own silence scan');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.silence_scans), 0, 'user 2 cannot see user 1''s silence scans');
select throws_ok(
  $$insert into public.silence_scans (owner_id, project_id, asset_id, params) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', '{}')$$,
  '42501', null, 'user 2 cannot insert a silence scan owned by user 1');
select throws_ok(
  $$insert into public.silence_scans (owner_id, project_id, asset_id, params) values ('22222222-2222-2222-2222-222222222222', 'dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-000000000001', '{}')$$,
  '23503', null, 'user 2 cannot attach a silence scan to user 1''s footage (owner-bound FK)');
reset role;

-- eeeeeeee-…-0001 above is the scriptless plan version 1 of project dddddddd-…-0001
select throws_ok(
  $$insert into public.edit_plans (owner_id, project_id, body, version) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{}', 1)$$,
  '23505', null, 'scriptless plans have unique versions per project');
select lives_ok(
  $$insert into public.edit_plans (owner_id, project_id, body, version) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{}', 2)$$,
  'the next scriptless version is accepted');

insert into public.projects (id, owner_id, profile_id, project_kind, title) values
  ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'PERSONAL_CONTENT', 'Skript');
insert into public.concepts (id, owner_id, project_id, body) values
  ('cccccccc-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000002', '{}');
insert into public.scripts (id, owner_id, concept_id, project_id, version, body) values
  ('cccccccc-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'cccccccc-0000-0000-0000-000000000002', 'dddddddd-0000-0000-0000-000000000002', 1, '{}');
insert into public.edit_plans (owner_id, project_id, script_id, body, version) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000002', 'cccccccc-0000-0000-0000-000000000003', '{}', 1),
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000002', null, '{}', 1);
select throws_ok(
  $$delete from public.scripts where id = 'cccccccc-0000-0000-0000-000000000003'$$,
  '23503', null, 'a script with edit plans cannot be deleted (no silent detach)');
select lives_ok(
  $$delete from public.projects where id = 'dddddddd-0000-0000-0000-000000000002'$$,
  'deleting the whole project removes its scripts and scripted and scriptless plans');
select is((select count(*)::int from public.edit_plans where project_id = 'dddddddd-0000-0000-0000-000000000002'), 0, 'no plans of the deleted project remain');

-- strategy module (0009) and context documents (0010): one whole document per version, the note on the check-in
select hasnt_column('public', 'context_versions', 'local_only', 'context versions have no separate local-only column');
select hasnt_column('public', 'context_versions', 'ai_safe', 'ai_safe is now the whole document (renamed to document)');
select has_column('public', 'self_assessments', 'note', 'self-assessments carry their note (Etappe 11)');
select hasnt_column('public', 'self_assessments', 'has_note', 'has_note is gone');

insert into public.context_versions (id, owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values
  ('abababab-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'strategy', 1, 'approved', '{"summary": "x"}', repeat('c', 64), 'import', now()),
  ('abababab-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 'strategy', 1, 'approved', '{"summary": "y"}', repeat('d', 64), 'manual', now());
insert into public.concepts (id, owner_id, project_id, body, strategy_version_id, pillar_id) values
  ('cccccccc-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{}', 'abababab-0000-0000-0000-000000000001', 'werkstatt');
insert into public.strategy_gates (owner_id, project_id, concept_id, strategy_version_id, pillar_id, joy_expected, within_boundaries, confirmed_at) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000009', 'abababab-0000-0000-0000-000000000001', 'werkstatt', 'ja', 'ja', now());
insert into public.self_assessments (owner_id, project_id, joy, strategy_version_id) values
  ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 4, 'abababab-0000-0000-0000-000000000001');

select throws_ok(
  $$insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'strategy', 2, 'approved', '{}', repeat('e', 64), 'copy', now())$$,
  '23505', null, 'only one approved strategy version per profile');
select throws_ok(
  $$insert into public.concepts (owner_id, project_id, body, strategy_version_id) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{}', 'abababab-0000-0000-0000-000000000002')$$,
  '23503', null, 'a concept cannot pin another owner''s strategy version (owner-bound FK)');
select throws_ok(
  $$delete from public.context_versions where id = 'abababab-0000-0000-0000-000000000001'$$,
  '23503', null, 'a strategy version pinned by a concept cannot be deleted');
select throws_ok(
  $$insert into public.self_assessments (owner_id, joy) values ('11111111-1111-1111-1111-111111111111', 6)$$,
  '23514', null, 'joy is 1 to 5');
select throws_ok(
  $$insert into public.self_assessments (owner_id, joy, subject_kind, subject_id) values ('11111111-1111-1111-1111-111111111111', 3, 'session', gen_random_uuid())$$,
  '23514', null, 'a session check-in has no subject');
select throws_ok(
  $$insert into public.self_assessments (owner_id, joy, subject_kind, subject_id) values ('11111111-1111-1111-1111-111111111111', 3, 'publication', gen_random_uuid())$$,
  '23514', null, 'a check-in on a piece needs „fertig“ answered');
select throws_ok(
  $$insert into public.strategy_gates (owner_id, project_id) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001')$$,
  '23514', null, 'a strategy gate needs exactly one subject');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select ok(
  (select count(*) from public.context_versions) = 1 and (select count(*) from public.strategy_gates) = 1 and (select count(*) from public.self_assessments) = 1,
  'user 1 sees own context version, gate and self-assessment');
reset role;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.context_versions where owner_id = '11111111-1111-1111-1111-111111111111'), 0, 'user 2 cannot see user 1''s context versions');
select is((select count(*)::int from public.strategy_gates), 0, 'user 2 cannot see user 1''s strategy gates');
select is((select count(*)::int from public.self_assessments), 0, 'user 2 cannot see user 1''s self-assessments');
reset role;

select throws_ok(
  $$insert into public.self_assessments (owner_id, joy, finished) values ('11111111-1111-1111-1111-111111111111', 3, true)$$,
  '23514', null, 'a session check-in never carries „fertig“ (it is not a finished piece)');

-- 0010: sources are their own version lines (one active per key); key, body and switch are required; the hash is optional
select lives_ok(
  $$insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, markdown, send_mode, source, approved_at) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'source', 'interview', 1, 'approved', '{}', 'Text', 'chat_voice_only', 'import_bundle', now()),
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'source', 'licht', 1, 'approved', '{}', 'Text', 'always', 'defaults', now())$$,
  'two sources with different keys are both active, without a hash');
select throws_ok(
  $$insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, markdown, send_mode, source, approved_at) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'source', 'interview', 2, 'approved', '{}', 'Text', 'never', 'manual', now())$$,
  '23505', null, 'only one active version per source key');
select throws_ok(
  $$insert into public.context_versions (owner_id, profile_id, kind, version, status, document, markdown, send_mode, source) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'source', 1, 'draft', '{}', 'Text', 'always', 'manual')$$,
  '23514', null, 'a source needs a key');
select throws_ok(
  $$insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, source) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'source', 'leer', 1, 'draft', '{}', 'manual')$$,
  '23514', null, 'a source needs its Markdown and its switch');
select lives_ok(
  $$update public.self_assessments set note = 'lief gut' where owner_id = '11111111-1111-1111-1111-111111111111'$$,
  'a self-check note is stored on the record');

-- a gate's subject must belong to the gate's own project
insert into public.projects (id, owner_id, profile_id, project_kind, title) values
  ('dddddddd-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'PERSONAL_CONTENT', 'Andere');
insert into public.concepts (id, owner_id, project_id, body) values
  ('cccccccc-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000004', '{}');
select throws_ok(
  $$insert into public.strategy_gates (owner_id, project_id, concept_id) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000011')$$,
  '23503', null, 'a gate cannot point at a concept of another project');

-- a profile whose version a session check-in pins cannot be deleted (check-ins are never removed as a side effect)
insert into public.creative_profiles (id, owner_id, name, profile_kind) values
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'Gesperrt', 'personal');
insert into public.context_versions (id, owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values
  ('abababab-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000004', 'strategy', 1, 'approved', '{}', repeat('a', 64), 'manual', now());
insert into public.self_assessments (owner_id, joy, strategy_version_id) values
  ('11111111-1111-1111-1111-111111111111', 4, 'abababab-0000-0000-0000-000000000005');
select throws_ok(
  $$delete from public.creative_profiles where id = 'aaaaaaaa-0000-0000-0000-000000000004'$$,
  '23503', null, 'a profile whose strategy version a session check-in pins cannot be deleted');

-- Etappe 14 (0011): her own fonts are owner-isolated, upright only and need a licence note
select has_table('public', 'fonts', 'fonts table exists (Etappe 14)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, size_bytes, sha256, storage_path, license) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'Geist-Regular.ttf', 'ttf', 'Geist', 'Geist-Regular', 'Geist Regular', 400, 1000, repeat('c', 64), 'fonts/11111111-2222-3333-4444-555555555555.ttf', 'SIL OFL 1.1')$$,
  'user 1 stores an own font with its licence note');
select throws_ok(
  $$insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, italic, size_bytes, sha256, storage_path, license) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'x.ttf', 'ttf', 'X', 'X-Italic', 'X Italic', 400, true, 1000, repeat('d', 64), 'fonts/11111111-2222-3333-4444-555555555556.ttf', '')$$,
  '23514', null, 'italic faces and an empty licence note are refused');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.fonts), 0, 'user 2 cannot see user 1''s fonts');
reset role;

-- Etappe 12 (0012): working drafts are owner-isolated, one per project and base
select has_table('public', 'edit_drafts', 'edit_drafts table exists (Etappe 12)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.edit_drafts (owner_id, project_id, body) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{"clips":[]}')$$,
  'user 1 stores a working draft of her project');
select throws_ok(
  $$insert into public.edit_drafts (owner_id, project_id, body) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '{"clips":[]}')$$,
  '23505', null, 'only one free-cut draft per project');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.edit_drafts), 0, 'user 2 cannot see user 1''s drafts');
reset role;

-- Etappe 15 (0013): chat threads and messages are owner-isolated; proposals only of the typed patch kinds
select has_table('public', 'chat_threads', 'chat_threads table exists (Etappe 15)');
select has_table('public', 'chat_messages', 'chat_messages table exists (Etappe 15)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.chat_threads (id, owner_id, scope) values ('cdcdcdcd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'brand');
    insert into public.chat_messages (owner_id, thread_id, role, body) values ('11111111-1111-1111-1111-111111111111', 'cdcdcdcd-0000-0000-0000-000000000001', 'user', 'mach den Akzent wärmer');
    insert into public.chat_messages (owner_id, thread_id, role, body, mock, proposals) values ('11111111-1111-1111-1111-111111111111', 'cdcdcdcd-0000-0000-0000-000000000001', 'assistant', '[MOCK] Vorschlag', true, '[{"kind":"design","status":"open"}]')$$,
  'user 1 stores a brand thread with her message and a mock answer');
select throws_ok(
  $$insert into public.chat_messages (owner_id, thread_id, role, body, proposals) values ('11111111-1111-1111-1111-111111111111', 'cdcdcdcd-0000-0000-0000-000000000001', 'assistant', 'x', '[{"kind":"render","status":"open"}]')$$,
  '23514', null, 'a proposal kind outside the typed patches (e.g. render) is refused');
select throws_ok(
  $$insert into public.chat_threads (owner_id, scope) values ('11111111-1111-1111-1111-111111111111', 'editor:dddddddd-0000-0000-0000-000000000001')$$,
  '23514', null, 'an editor thread needs its project');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.chat_threads), 0, 'user 2 cannot see user 1''s chat threads');
select is((select count(*)::int from public.chat_messages), 0, 'user 2 cannot see user 1''s chat messages');
reset role;

-- Etappe 16 (0014): story plans are owner-isolated; chat proposals of kind `story`; references.usage needs a source when licensed
select has_table('public', 'story_plans', 'story_plans table exists (Etappe 16)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.story_plans (owner_id, project_id, draft_revision, prompt_version, mock, provider, model, body) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 1, 'edit-director@1', true, 'mock', 'mock', '{"beats":[],"hooks":[],"sentences":[]}');
    insert into public.chat_messages (owner_id, thread_id, role, body, mock, proposals) values ('11111111-1111-1111-1111-111111111111', 'cdcdcdcd-0000-0000-0000-000000000001', 'assistant', '[MOCK] Hook 2', true, '[{"kind":"story","status":"open"}]')$$,
  'user 1 stores a dramaturgy proposal and a chat proposal of kind story');
select throws_ok(
  $$insert into public.story_plans (owner_id, project_id, draft_revision, prompt_version, provider, model, body) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 1, 'x', 'mock', 'mock', '{"beats":[]}')$$,
  '23514', null, 'a proposal body without hooks and sentences is refused');
select throws_ok(
  $$update public.references set usage = '{"origin":"licensed","source":""}' where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  '23514', null, 'a licensed image without a source cannot be marked as usable in videos');
select lives_ok(
  $$update public.references set usage = '{"origin":"own","source":""}' where id = 'cccccccc-0000-0000-0000-000000000001'$$,
  'her own image can be marked as usable in videos');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.story_plans), 0, 'user 2 cannot see user 1''s dramaturgy proposals');
reset role;

-- Etappe 17 (0015): renders.finish records the package files and the QA result; unknown files are refused
select has_column('public', 'renders', 'finish', 'renders.finish exists (Etappe 17)');
select lives_ok(
  $$update public.renders set finish = '{"files":{"clean":{"storagePath":"renders/p/finish/r/video-clean.mp4","size":10,"sha256":"x","createdAt":"t"}},"qa":{"findings":[],"expected":0}}' where owner_id = '11111111-1111-1111-1111-111111111111'$$,
  'a render records its clean video and a QA result');
select throws_ok(
  $$update public.renders set finish = '{"files":{"video":{"storagePath":"x","size":1}}}' where owner_id = '11111111-1111-1111-1111-111111111111'$$,
  '23514', null, 'an unknown package file is refused');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.renders where finish is not null), 0, 'user 2 cannot see user 1''s package records');
reset role;

-- Etappe 16b (0016): a Google font records family, versioned gstatic URL and licence; anything else is refused
select has_column('public', 'fonts', 'origin_kind', 'fonts.origin_kind exists (Etappe 16b)');
select lives_ok(
  $$insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, size_bytes, sha256, storage_path, license, origin_kind, google_family, source_url, license_id, license_url) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'BebasNeue-400.ttf', 'ttf', 'Bebas Neue', 'BebasNeue-Regular', 'Bebas Neue Regular', 400, 56136, repeat('9', 64), 'fonts/11111111-2222-3333-4444-555555555590.ttf',
     'SIL Open Font License 1.1 · Google Fonts „Bebas Neue“', 'google', 'Bebas Neue', 'https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXooxW4.ttf', 'OFL-1.1', 'https://openfontlicense.org')$$,
  'a Google font with family, versioned file URL and licence is stored');
select throws_ok(
  $$insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, size_bytes, sha256, storage_path, license, origin_kind, google_family, source_url, license_id, license_url) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'x.ttf', 'ttf', 'X', 'X-Google', 'X Google', 400, 100, repeat('8', 64), 'fonts/11111111-2222-3333-4444-555555555591.ttf',
     'OFL', 'google', 'X', 'https://evil.example/s/x/v1/x.ttf', 'OFL-1.1', 'https://openfontlicense.org')$$,
  '23514', null, 'a Google font from another host is refused');
select throws_ok(
  $$insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, size_bytes, sha256, storage_path, license, origin_kind) values
    ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001', 'x.ttf', 'ttf', 'X', 'X-Google2', 'X Google2', 400, 100, repeat('7', 64), 'fonts/11111111-2222-3333-4444-555555555592.ttf', 'OFL', 'google')$$,
  '23514', null, 'a Google font without source and licence is refused');

-- Etappe 18 (0017): carousels and their versions are owner-isolated, one active version, a carousel chat thread
select has_table('public', 'carousels', 'carousels table exists (Etappe 18)');
select has_table('public', 'carousel_versions', 'carousel_versions table exists (Etappe 18)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.carousels (id, owner_id, project_id, title, source_kind, source_label) values ('ecececec-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', 'Morgenstricken', 'note', 'Notiz');
    insert into public.carousel_versions (owner_id, carousel_id, version, status, origin, body, prompt_version, mock) values ('11111111-1111-1111-1111-111111111111', 'ecececec-0000-0000-0000-000000000001', 1, 'active', 'agent', '{"format":"portrait","templateId":"klar","caption":"","slides":[{"id":"s1","kind":"title"},{"id":"s2","kind":"cta"}]}', 'carousel-writer@1', true);
    insert into public.chat_threads (owner_id, scope, project_id, carousel_id) values ('11111111-1111-1111-1111-111111111111', 'carousel:ecececec-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'ecececec-0000-0000-0000-000000000001')$$,
  'user 1 stores a carousel, its first version and its chat thread');
select throws_ok(
  $$insert into public.carousel_versions (owner_id, carousel_id, version, status, origin, body) values ('11111111-1111-1111-1111-111111111111', 'ecececec-0000-0000-0000-000000000001', 2, 'active', 'user_edit', '{"format":"portrait","templateId":"klar","caption":"","slides":[{"id":"s1","kind":"title"},{"id":"s2","kind":"cta"}]}')$$,
  '23505', null, 'only one active version per carousel');
select throws_ok(
  $$insert into public.carousel_versions (owner_id, carousel_id, version, status, origin, body) values ('11111111-1111-1111-1111-111111111111', 'ecececec-0000-0000-0000-000000000001', 3, 'archived', 'user_edit', '{"format":"portrait","templateId":"klar","caption":"","slides":[{"id":"s1","kind":"title"}]}')$$,
  '23514', null, 'a carousel needs 2 to 10 slides');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.carousels) + (select count(*)::int from public.carousel_versions), 0, 'user 2 cannot see user 1''s carousels');
reset role;

-- Etappe 19/20 (0018, 0019): stories, board items and week plans are owner-isolated; clip ≤ 15 s; „posted“ needs her date
select has_table('public', 'stories', 'stories table exists (Etappe 19)');
select has_table('public', 'board_items', 'board_items table exists (Etappe 20)');
select has_table('public', 'week_plans', 'week_plans table exists (Etappe 20)');
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
select lives_ok(
  $$insert into public.stories (id, owner_id, project_id, batch_id, title, source_kind, source_carousel_id, source_label, origin, prompt_version, mock, body) values ('5707e500-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 'Teaser', 'carousel', 'ecececec-0000-0000-0000-000000000001', 'Karussell', 'agent', 'story-writer@1', true,
      '{"kind":"teaser","media":{"kind":"carousel_slide","carouselId":"ecececec-0000-0000-0000-000000000001","n":1},"kicker":"Neues Karussell","title":"Morgenstricken","body":"","sticker":{"kind":"link"}}');
    insert into public.week_plans (owner_id, week_start, prompt_version, suggestions) values ('11111111-1111-1111-1111-111111111111', '2026-11-16', 'week-planner@1', '[{"kind":"reel","status":"open"}]');
    insert into public.board_items (owner_id, project_id, day, slot, kind, title, status, ref_kind, ref_story_id, origin) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', '2026-11-20', 'story', 'story', 'Teaser', 'in_progress', 'story', '5707e500-0000-0000-0000-000000000001', 'manual');
    insert into public.chat_threads (owner_id, scope) values ('11111111-1111-1111-1111-111111111111', 'week')$$,
  'user 1 stores a story from a carousel, a week plan, a board entry linked to the story and the board chat');
select throws_ok(
  $$insert into public.stories (owner_id, project_id, batch_id, title, source_kind, source_label, origin, body) values ('11111111-1111-1111-1111-111111111111', 'dddddddd-0000-0000-0000-000000000001', gen_random_uuid(), 'Clip', 'note', 'Notiz', 'manual',
      '{"kind":"bts","media":{"kind":"clip","source":"render","id":"x","startSec":0,"durationSec":20},"kicker":"","title":"x","body":"","sticker":{"kind":"none"}}')$$,
  '23514', null, 'a clip story is at most 15 s');
select throws_ok(
  $$insert into public.board_items (owner_id, day, slot, kind, title, status, origin) values ('11111111-1111-1111-1111-111111111111', '2026-11-20', 'main', 'reel', 'Reel', 'posted', 'manual')$$,
  '23514', null, '„posted“ only with her date');
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
select is((select count(*)::int from public.stories) + (select count(*)::int from public.board_items) + (select count(*)::int from public.week_plans), 0, 'user 2 cannot see user 1''s stories, board or week plans');
select throws_ok(
  $$insert into public.board_items (owner_id, day, slot, kind, title, status, origin) values ('11111111-1111-1111-1111-111111111111', '2026-11-20', 'main', 'idea', 'x', 'idea', 'manual')$$,
  '42501', null, 'user 2 cannot write onto user 1''s board');
reset role;

-- deleting a whole user with pinned versions succeeds: NO ACTION is checked at the end of the cascade
insert into auth.users (id, aud, role, email) values
  ('33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'u3@test.invalid');
insert into public.creative_profiles (id, owner_id, name, profile_kind) values
  ('aaaaaaaa-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'C', 'personal');
insert into public.context_versions (id, owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values
  ('abababab-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 'strategy', 1, 'approved', '{}', repeat('f', 64), 'manual', now()),
  ('abababab-0000-0000-0000-000000000004', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 'profile', 1, 'approved', '{}', repeat('f', 64), 'manual', now());
insert into public.projects (id, owner_id, profile_id, project_kind, title) values
  ('dddddddd-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'aaaaaaaa-0000-0000-0000-000000000003', 'PERSONAL_CONTENT', 'P3');
insert into public.concepts (id, owner_id, project_id, body, strategy_version_id, profile_version_id) values
  ('cccccccc-0000-0000-0000-000000000010', '33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000003', '{}', 'abababab-0000-0000-0000-000000000003', 'abababab-0000-0000-0000-000000000004');
insert into public.strategy_gates (owner_id, project_id, concept_id, strategy_version_id) values
  ('33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000003', 'cccccccc-0000-0000-0000-000000000010', 'abababab-0000-0000-0000-000000000003');
insert into public.self_assessments (owner_id, joy, strategy_version_id) values
  ('33333333-3333-3333-3333-333333333333', 5, 'abababab-0000-0000-0000-000000000003');
insert into public.agent_runs (owner_id, project_id, agent_name, prompt_version, model, strategy_version_id, profile_version_id, ai_context_hash) values
  ('33333333-3333-3333-3333-333333333333', 'dddddddd-0000-0000-0000-000000000003', 'content_strategist', 'p@2', 'mock', 'abababab-0000-0000-0000-000000000003', 'abababab-0000-0000-0000-000000000004', repeat('f', 64));
select lives_ok(
  $$delete from auth.users where id = '33333333-3333-3333-3333-333333333333'$$,
  'deleting a user with pinned context versions succeeds (postgres connection: service_role has no DELETE on auth.users)');
select is((select count(*)::int from public.context_versions where owner_id = '33333333-3333-3333-3333-333333333333'), 0, 'the deleted user''s context versions are gone');
select is(
  (select count(*)::int from public.concepts where owner_id = '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.strategy_gates where owner_id = '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.self_assessments where owner_id = '33333333-3333-3333-3333-333333333333')
  + (select count(*)::int from public.agent_runs where owner_id = '33333333-3333-3333-3333-333333333333'),
  0, 'the deleted user''s concepts, gates, self-assessments and agent runs are gone');

select * from finish();
rollback;
