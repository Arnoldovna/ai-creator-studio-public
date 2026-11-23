// Executes supabase/migrations/*.sql against PGlite (Postgres in WASM) with minimal stubs
// of Supabase's `auth` and `storage` schemas, then checks owner-based RLS isolation.
// This is a syntax/semantics smoke test — NOT a substitute for applying on a real Supabase dev DB.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const dir = path.join(import.meta.dirname, '..', 'migrations');
const STUBS = `
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create role authenticated;
grant usage on schema public, auth to authenticated;
create schema storage;
grant usage on schema storage to authenticated;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant select, insert, update, delete on storage.objects to authenticated;
`;

test('migrations apply cleanly and RLS isolates owners', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 2);
  for (const f of files) {
    // 0004 must also apply when assets rows from before it exist (backfill)
    if (f.startsWith('0004')) {
      await db.exec(`insert into auth.users values ('99999999-9999-9999-9999-999999999999')`);
      for (const origin of ['own', 'generated', 'licensed']) await db.exec(`insert into public.assets (owner_id, storage_path, mime_type, size_bytes, origin) values ('99999999-9999-9999-9999-999999999999', 'legacy/${origin}', 'video/mp4', 1, '${origin}')`);
    }
    // 0005 must apply with legacy edit plans, renders and jobs in old states
    if (f.startsWith('0005')) {
      const legacy = '99999999-9999-9999-9999-999999999999';
      await db.exec(`insert into public.creative_profiles (id, owner_id, name, profile_kind) values ('99999999-0000-0000-0000-000000000001', '${legacy}', 'L', 'personal');
        insert into public.projects (id, owner_id, profile_id, project_kind, title) values ('99999999-0000-0000-0000-000000000002', '${legacy}', '99999999-0000-0000-0000-000000000001', 'PERSONAL_CONTENT', 'L');
        insert into public.edit_plans (id, owner_id, project_id, body) values ('99999999-0000-0000-0000-000000000003', '${legacy}', '99999999-0000-0000-0000-000000000002', '{}');
        insert into public.renders (owner_id, edit_plan_id, status) values ('${legacy}', '99999999-0000-0000-0000-000000000003', 'queued'), ('${legacy}', '99999999-0000-0000-0000-000000000003', 'weird');
        insert into public.workflow_jobs (owner_id, workflow_name, idempotency_key, status) values ('${legacy}', 'x', 'legacy-key-1', 'pending');`);
    }
    // 0008 must apply with two legacy scriptless plans of the same version in one project
    if (f.startsWith('0008')) {
      await db.exec(`insert into public.edit_plans (id, owner_id, project_id, body, created_at) values ('99999999-0000-0000-0000-000000000004', '99999999-9999-9999-9999-999999999999', '99999999-0000-0000-0000-000000000002', '{}', now() + interval '1 second')`);
    }
    // 0009 must apply with lineage rows from before Etappe 9 (concept, script, publication, agent run; plans exist above)
    if (f.startsWith('0009')) {
      const legacy = '99999999-9999-9999-9999-999999999999', lp = '99999999-0000-0000-0000-000000000002';
      await db.exec(`insert into public.agent_runs (id, owner_id, project_id, agent_name, prompt_version, model, status) values ('99999999-0000-0000-0000-000000000010', '${legacy}', '${lp}', 'content_strategist', 'p@1', 'mock', 'succeeded');
        insert into public.concepts (id, owner_id, project_id, body, status, agent_run_id) values ('99999999-0000-0000-0000-000000000011', '${legacy}', '${lp}', '{}', 'approved', '99999999-0000-0000-0000-000000000010');
        insert into public.scripts (id, owner_id, concept_id, project_id, version, body, status) values ('99999999-0000-0000-0000-000000000012', '${legacy}', '99999999-0000-0000-0000-000000000011', '${lp}', 1, '{}', 'approved');
        insert into public.publications (id, owner_id, project_id, concept_id, script_id, published_at) values ('99999999-0000-0000-0000-000000000013', '${legacy}', '${lp}', '99999999-0000-0000-0000-000000000011', '99999999-0000-0000-0000-000000000012', now());`);
    }
    // 0010 must apply with Etappe-9 context versions and self-checks (old shape: ai_safe, has_note)
    if (f.startsWith('0010')) {
      const legacy = '99999999-9999-9999-9999-999999999999', lprof = '99999999-0000-0000-0000-000000000001';
      await db.exec(`insert into public.context_versions (id, owner_id, profile_id, kind, version, status, ai_safe, ai_text_hash, source, approved_at, import_warnings) values ('99999999-0000-0000-0000-000000000020', '${legacy}', '${lprof}', 'strategy', 1, 'approved', '{"summary": "alt"}', '${'c'.repeat(64)}', 'import', now(), '["summary_empty"]');
        insert into public.self_assessments (owner_id, joy, has_note) values ('${legacy}', 4, true);`);
    }
    try {
      await db.exec(await readFile(path.join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`${f}: ${e.message}`);
    }
  }
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated;`);
  const u1 = '11111111-1111-1111-1111-111111111111', u2 = '22222222-2222-2222-2222-222222222222';
  await db.exec(`insert into auth.users values ('${u1}'), ('${u2}');
    insert into public.creative_profiles (owner_id, name, profile_kind) values ('${u1}', 'A', 'personal'), ('${u2}', 'B', 'personal');`);

  const asUser = async (uid, sql) => {
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${uid}', false);`);
    try { return await db.query(sql); } finally { await db.exec('reset role;'); }
  };
  const visible = await asUser(u1, 'select name from public.creative_profiles');
  assert.deepEqual(visible.rows.map((r) => r.name), ['A']);
  await assert.rejects(asUser(u1, `insert into public.creative_profiles (owner_id, name, profile_kind) values ('${u2}', 'X', 'personal')`), /row-level security/);

  // project kinds from the app are accepted, old ones rejected
  const pid = (await db.query(`select id from public.creative_profiles where owner_id = '${u1}'`)).rows[0].id;
  await db.exec(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'UGC_CLIENT', 'K')`);
  await assert.rejects(db.exec(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'personal', 'K')`));

  // footage (0004): rights confirmed, note for licensed/client, generated only as kind 'generated', dedup per project
  const projectId = (await db.query(`select id from public.projects where owner_id = '${u1}' limit 1`)).rows[0].id;
  const asset = (cols, vals) => db.exec(`insert into public.assets (owner_id, project_id, storage_path, mime_type, size_bytes, ${cols}) values ('${u1}', '${projectId}', 'footage/x.mp4', 'video/mp4', 1, ${vals})`);
  const sha = 'a'.repeat(64);
  await asset('origin, name, sha256, rights_confirmed_at', `'own', 'take1.mov', '${sha}', now()`);
  await assert.rejects(asset('origin, name, sha256, rights_confirmed_at', `'own', 'dup.mov', '${sha}', now()`), /duplicate key/);
  await assert.rejects(asset('origin, name', `'own', 'no-rights.mov'`), /assets_footage_rights_confirmed/);
  await assert.rejects(asset('origin, name, rights_confirmed_at', `'client', 'c.mov', now()`), /assets_rights_note_required/);
  await asset('origin, name, rights_confirmed_at, rights_note', `'client', 'c.mov', now(), 'Mail vom 12.11.'`);
  await assert.rejects(asset('origin, name, rights_confirmed_at', `'generated', 'g.mp4', now()`), /assets_generated_kind/);

  // edit plans + renders (0005): unique versions per script, approval timestamps, renders under review have a file
  const plan = (cols, vals) => db.query(`insert into public.edit_plans (owner_id, project_id, body, ${cols}) values ('${u1}', '${projectId}', '{}', ${vals}) returning id`);
  const p1 = (await plan('status, approved_at', `'approved', now()`)).rows[0].id;
  await assert.rejects(plan('status', `'approved'`), /edit_plans_approved_at/);
  await assert.rejects(plan('status', `'final'`), /check/);
  await assert.rejects(db.exec(`insert into public.renders (owner_id, edit_plan_id, status) values ('${u1}', '${p1}', 'pending_review')`), /renders_output_present/);
  await db.exec(`insert into public.renders (owner_id, edit_plan_id) values ('${u1}', '${p1}')`);
  assert.equal((await db.query(`select status from public.renders where edit_plan_id = '${p1}'`)).rows[0].status, 'rendering');
  // render look (0008): null for renders without hook/overlays, otherwise an object
  assert.equal((await db.query(`select look from public.renders where edit_plan_id = '${p1}'`)).rows[0].look, null);
  await db.exec(`update public.renders set look = '{"source": "placeholder", "font": "Avenir Next", "warnings": []}' where edit_plan_id = '${p1}'`);
  await assert.rejects(db.exec(`update public.renders set look = '[]' where edit_plan_id = '${p1}'`), /check constraint/);
  await assert.rejects(db.exec(`insert into public.edit_plans (owner_id, project_id, body, parent_id) values ('${u2}', '${projectId}', '{}', '${p1}')`), /foreign key|violates/);
  await assert.rejects(asUser(u1, `insert into public.budget_reservations (owner_id, amount_usd, purpose, process_id) values ('${u2}', 1, 'x', 'p')`), /row-level security/);
  assert.deepEqual((await db.query(`select status from public.renders where owner_id = '99999999-9999-9999-9999-999999999999' order by status`)).rows.map((r) => r.status), ['failed', 'rendering']);

  // free cut (0008): scriptless plans number their versions per project; legacy duplicates were renumbered
  assert.deepEqual((await db.query(`select version from public.edit_plans where project_id = '99999999-0000-0000-0000-000000000002' order by version`)).rows.map((r) => r.version), [1, 2]);
  await assert.rejects(plan('version', '1'), /edit_plans_free_cut_version_key/); // p1 is free cut v1 of this project
  const freeV2 = (await plan('version', '2')).rows[0].id;
  // the same version number is fine for a scripted plan, and a script with plans cannot be deleted (no silent detach)
  const concept = (await db.query(`insert into public.concepts (owner_id, project_id, body) values ('${u1}', '${projectId}', '{}') returning id`)).rows[0].id;
  const scriptRow = (await db.query(`insert into public.scripts (owner_id, concept_id, project_id, version, body) values ('${u1}', '${concept}', '${projectId}', 1, '{}') returning id`)).rows[0].id;
  await plan('version, script_id', `2, '${scriptRow}'`);
  await assert.rejects(db.exec(`delete from public.scripts where id = '${scriptRow}'`), /edit_plans_script_id_owner_fkey/);
  await assert.rejects(db.exec(`delete from public.concepts where id = '${concept}'`), /edit_plans_script_id_owner_fkey/);
  // deleting a whole project removes scripted and scriptless plans together
  const pFree = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Frei') returning id`)).rows[0].id;
  const c2 = (await db.query(`insert into public.concepts (owner_id, project_id, body) values ('${u1}', '${pFree}', '{}') returning id`)).rows[0].id;
  const s2 = (await db.query(`insert into public.scripts (owner_id, concept_id, project_id, version, body) values ('${u1}', '${c2}', '${pFree}', 1, '{}') returning id`)).rows[0].id;
  await db.exec(`insert into public.edit_plans (owner_id, project_id, body, script_id) values ('${u1}', '${pFree}', '{}', '${s2}'), ('${u1}', '${pFree}', '{}', null)`);
  await db.exec(`delete from public.projects where id = '${pFree}'`);
  assert.equal((await db.query(`select count(*)::int as n from public.edit_plans where project_id = '${pFree}'`)).rows[0].n, 0);
  assert.ok(freeV2);

  // transcripts (0006): versions per asset, corrections need a parent, owner-bound
  const assetId = (await db.query(`select id from public.assets where owner_id = '${u1}' limit 1`)).rows[0].id;
  const tr = (cols, vals, owner = u1) => db.query(`insert into public.transcripts (owner_id, project_id, asset_id, storage_path, ${cols}) values ('${owner}', '${projectId}', '${assetId}', 'transcripts/x.json', ${vals}) returning id`);
  const t1 = (await tr('version, source', `1, 'whisper'`)).rows[0].id;
  await assert.rejects(tr('version, source', `1, 'whisper'`), /duplicate key/);
  await assert.rejects(tr('version, source', `2, 'user_edit'`), /transcripts_edit_has_parent/);
  await tr('version, source, parent_id', `2, 'user_edit', '${t1}'`);
  await assert.rejects(tr('version, source', `3, 'whisper'`, u2), /foreign key|violates/);
  assert.equal((await asUser(u2, `select * from public.transcripts`)).rows.length, 0);
  // filler prompt + silence scans (0008): old rows default to false; scans are owner-bound, RLS-isolated and go with the asset
  assert.equal((await db.query(`select filler_prompt from public.transcripts where id = '${t1}'`)).rows[0].filler_prompt, false);
  const scan = (vals, owner = u1) => db.query(`insert into public.silence_scans (owner_id, project_id, asset_id, params, ranges) values ('${owner}', '${projectId}', '${assetId}', ${vals}) returning id`);
  await scan(`'{"noiseDb": -38.5, "minSilenceSec": 0.15, "meanDb": -18.5}', '[{"startSec": 0.2, "endSec": 0.5}]'`);
  await assert.rejects(scan(`'[]', '[]'`), /check constraint/);
  await assert.rejects(scan(`'{}', '{}'`), /check constraint/);
  await assert.rejects(scan(`'{}', '[]'`, u2), /foreign key|violates/);
  // one scan per clip, as in the app: a second insert conflicts, the upsert replaces it
  await assert.rejects(scan(`'{}', '[]'`), /silence_scans_one_per_asset/);
  await db.exec(`insert into public.silence_scans (owner_id, project_id, asset_id, params, ranges) values ('${u1}', '${projectId}', '${assetId}', '{"noiseDb": -40}', '[]')
    on conflict (owner_id, asset_id) do update set params = excluded.params, ranges = excluded.ranges, created_at = now()`);
  assert.deepEqual((await db.query(`select params, ranges from public.silence_scans where asset_id = '${assetId}'`)).rows, [{ params: { noiseDb: -40 }, ranges: [] }]);
  assert.equal((await asUser(u2, `select * from public.silence_scans`)).rows.length, 0);
  assert.equal((await asUser(u1, `select * from public.silence_scans`)).rows.length, 1);
  await assert.rejects(asUser(u1, `insert into public.silence_scans (owner_id, project_id, asset_id, params) values ('${u2}', '${projectId}', '${assetId}', '{}')`), /row-level security/);

  // generations (0007): opt-in budget, generated assets carry a review state, every state after `quoted` is approved
  await assert.rejects(db.exec(`update public.projects set ai_broll_credit_budget = 50 where id = '${projectId}'`), /projects_ai_broll_budget_needs_opt_in/);
  await db.exec(`update public.projects set ai_broll_opt_in_at = now(), ai_broll_credit_budget = 50 where id = '${projectId}'`);
  assert.equal((await db.query(`select generation_review from public.assets where storage_path = 'legacy/generated'`)).rows[0].generation_review, 'pending'); // backfill
  await assert.rejects(asset('origin, kind, name', `'generated', 'generated', 'g.mp4'`), /assets_generation_review/);
  await asset('origin, kind, name, generation_review', `'generated', 'generated', 'g.mp4', 'pending'`);
  const gen = (cols, vals, owner = u1) => db.query(`insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, resolution, prompt, duration_sec, quoted_credits${cols ? `, ${cols}` : ''}) values ('${owner}', '${projectId}', gen_random_uuid(), 0, 0, 'seedance_2_5', '720p', 'Wolle im Licht', 5, 25${vals ? `, ${vals}` : ''}) returning id`);
  const g1 = (await gen('', '')).rows[0].id;
  await assert.rejects(gen('status', `'queued'`), /generations_approval/); // no create without approval
  await assert.rejects(gen('status, approved_max_credits, approved_at', `'queued', 20, now()`), /generations_approval_covers_quote/);
  await assert.rejects(db.exec(`update public.generations set model = 'text2image_soul_v2', resolution = null where id = '${g1}'`), /generations_model_check/);
  // only Seedance has a resolution param; Kling/Veo rows carry none
  await assert.rejects(db.exec(`update public.generations set resolution = null where id = '${g1}'`), /generations_resolution/);
  await assert.rejects(db.exec(`update public.generations set model = 'kling3_0' where id = '${g1}'`), /generations_resolution/);
  await assert.rejects(gen('status, approved_max_credits, approved_at, credits_charged', `'review', 25, now(), 25`), /generations_submitted/);
  await assert.rejects(gen('status, approved_max_credits, approved_at, submitted_at', `'failed', 25, now(), now()`), /generations_charged/);
  await assert.rejects(gen('status, approved_max_credits, approved_at, submitted_at, credits_charged, reviewed_at', `'rejected', 25, now(), now(), 25, now()`), /generations_reject_reason/);
  await gen('status, approved_max_credits, approved_at, submitted_at, credits_charged, failure', `'failed', 25, now(), now(), 25, 'nsfw'`);
  await assert.rejects(gen('', '', u2), /foreign key|violates/);
  assert.equal((await asUser(u2, `select * from public.generations`)).rows.length, 0);
  assert.equal((await asUser(u1, `select * from public.generations where id = '${g1}'`)).rows.length, 1);
  // deleting the project keeps the row for the credit sum, without the prompt
  const pDel = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Weg') returning id`)).rows[0].id;
  const gDel = (await db.query(`insert into public.generations (owner_id, project_id, storyboard_id, brief_index, scene_index, model, prompt, duration_sec, quoted_credits) values ('${u1}', '${pDel}', gen_random_uuid(), 0, 0, 'kling3_0', 'geheim', 5, 9) returning id`)).rows[0].id;
  await db.exec(`delete from public.projects where id = '${pDel}'`);
  assert.deepEqual((await db.query(`select project_id, prompt from public.generations where id = '${gDel}'`)).rows[0], { project_id: null, prompt: '[Projekt gelöscht]' });

  // strategy module (0009): legacy lineage rows keep null pins and still satisfy every 0009 constraint
  const legacyOwner = '99999999-9999-9999-9999-999999999999';
  for (const [tbl, cols] of [
    ['concepts', 'strategy_version_id, profile_version_id, pillar_id'],
    ['scripts', 'strategy_version_id, profile_version_id, pillar_id'],
    ['edit_plans', 'strategy_version_id, profile_version_id, pillar_id'],
    ['publications', 'strategy_version_id, pillar_id, edit_plan_id'],
    ['agent_runs', 'strategy_version_id, profile_version_id, ai_context_hash'],
  ]) {
    const rows = (await db.query(`select ${cols} from public.${tbl} where owner_id = '${legacyOwner}'`)).rows;
    assert.ok(rows.length >= 1, `legacy ${tbl} rows exist`);
    for (const r of rows) assert.ok(Object.values(r).every((v) => v === null), `legacy ${tbl} pins are null`);
    // re-writing every legacy row re-checks all row constraints added by 0009
    await db.exec(`update public.${tbl} set owner_id = owner_id where owner_id = '${legacyOwner}'`);
  }
  // Etappe 11 (0010): one whole document per version, the note on the self-check; no separate local-only column
  const cols = async (tbl) => (await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = '${tbl}'`)).rows.map((r) => r.column_name);
  assert.ok(!(await cols('context_versions')).includes('local_only'));
  assert.ok(!(await cols('context_versions')).includes('ai_safe'));
  assert.ok(!(await cols('context_versions')).includes('import_warnings'));
  for (const c of ['document', 'document_format', 'source_key', 'markdown', 'send_mode']) assert.ok((await cols('context_versions')).includes(c), `context_versions.${c}`);
  assert.ok((await cols('self_assessments')).includes('note'));
  assert.ok(!(await cols('self_assessments')).includes('has_note'));
  // rows from before 0010 survive: the old jsonb under `document` with format 1, an empty note
  assert.deepEqual((await db.query(`select document, document_format, source_key from public.context_versions where id = '99999999-0000-0000-0000-000000000020'`)).rows[0], { document: { summary: 'alt' }, document_format: 1, source_key: null });
  assert.equal((await db.query(`select note from public.self_assessments where owner_id = '${legacyOwner}'`)).rows[0].note, '');

  const hash = 'b'.repeat(64);
  const cv = (owner, profile, kind, version, status, extra = {}) => db.query(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at${extra.id ? ', id' : ''})
    values ('${owner}', '${profile}', '${kind}', ${version}, '${status}', '{"summary": "x"}', '${extra.hash ?? hash}', 'manual', ${status === 'draft' ? 'null' : 'now()'}${extra.id ? `, '${extra.id}'` : ''}) returning id`);
  const sv1 = (await cv(u1, pid, 'strategy', 1, 'approved')).rows[0].id;
  await assert.rejects(cv(u1, pid, 'strategy', 2, 'approved'), /context_versions_one_approved/);
  await cv(u1, pid, 'profile', 1, 'approved'); // one approved per kind
  await cv(u1, pid, 'strategy', 2, 'draft');
  await assert.rejects(cv(u1, pid, 'strategy', 2, 'draft'), /context_versions_version_key/);
  await assert.rejects(cv(u1, pid, 'strategy', 3, 'draft', { hash: 'nope' }), /check constraint/);
  // 0010: the hash is optional; new origins; sources need key, body and switch, one active version per key
  await db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, source) values ('${u1}', '${pid}', 'strategy', 7, 'draft', '{}', 'import_bundle')`);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, source) values ('${u1}', '${pid}', 'strategy', 8, 'draft', '{}', 'erfunden')`), /context_versions_source_check/);
  const src = (key, version, status) => db.exec(`insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, markdown, send_mode, source, approved_at)
    values ('${u1}', '${pid}', 'source', ${key ? `'${key}'` : 'null'}, ${version}, '${status}', '{}', 'Text', 'chat_voice_only', 'defaults', ${status === 'draft' ? 'null' : 'now()'})`);
  await src('interview', 1, 'approved');
  await src('licht', 1, 'approved'); // another key: its own active version and its own numbering
  await assert.rejects(src('interview', 2, 'approved'), /context_versions_one_approved/);
  await src('interview', 2, 'archived');
  await assert.rejects(src('interview', 2, 'archived'), /context_versions_version_key/);
  await assert.rejects(src(null, 3, 'archived'), /context_versions_source_key/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, source) values ('${u1}', '${pid}', 'strategy', 'interview', 9, 'draft', '{}', 'manual')`), /context_versions_source_key/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, source) values ('${u1}', '${pid}', 'source', 'ohne-text', 1, 'draft', '{}', 'manual')`), /context_versions_source_body/);
  await assert.rejects(src('Gross Und Klein', 1, 'draft'), /check constraint/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, source_key, version, status, document, markdown, send_mode, source) values ('${u1}', '${pid}', 'source', 'schalter', 1, 'draft', '{}', 'Text', 'manchmal', 'manual')`), /context_versions_send_mode_check/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source) values ('${u1}', '${pid}', 'strategy', 4, 'archived', '{}', '${hash}', 'manual')`), /context_versions_approved_at/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values ('${u1}', '${pid}', 'strategy', 5, 'draft', '{}', '${hash}', 'manual', now())`), /context_versions_approved_at/);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source) values ('${u1}', '${pid}', 'strategy', 6, 'draft', '[]', '${hash}', 'manual')`), /check constraint/);
  const pid2 = (await db.query(`select id from public.creative_profiles where owner_id = '${u2}'`)).rows[0].id;
  await assert.rejects(cv(u1, pid2, 'strategy', 1, 'draft'), /foreign key|violates/); // version on another owner's profile
  const sv2 = (await cv(u2, pid2, 'strategy', 1, 'approved')).rows[0].id;
  // pins: owner-bound, and a pinned version cannot be deleted
  const pinned = (await db.query(`insert into public.concepts (owner_id, project_id, body, strategy_version_id, pillar_id) values ('${u1}', '${projectId}', '{}', '${sv1}', 'werkstatt') returning id`)).rows[0].id;
  await assert.rejects(db.exec(`insert into public.concepts (owner_id, project_id, body, strategy_version_id) values ('${u1}', '${projectId}', '{}', '${sv2}')`), /concepts_strategy_version_id_owner_fkey/);
  await assert.rejects(db.exec(`insert into public.concepts (owner_id, project_id, body, pillar_id) values ('${u1}', '${projectId}', '{}', 'Werkstatt!')`), /concepts_pillar_id_format/);
  await assert.rejects(db.exec(`update public.agent_runs set ai_context_hash = 'x' where owner_id = '${legacyOwner}'`), /check constraint/);
  await assert.rejects(db.exec(`delete from public.context_versions where id = '${sv1}'`), /concepts_strategy_version_id_owner_fkey/);
  // publication → edit plan: deleting the plan only nulls the reference
  const pubPlan = (await plan('version', '7')).rows[0].id;
  const pub = (await db.query(`insert into public.publications (owner_id, project_id, edit_plan_id, strategy_version_id, pillar_id) values ('${u1}', '${projectId}', '${pubPlan}', '${sv1}', 'werkstatt') returning id`)).rows[0].id;
  await db.exec(`delete from public.edit_plans where id = '${pubPlan}'`);
  assert.deepEqual((await db.query(`select edit_plan_id, owner_id from public.publications where id = '${pub}'`)).rows[0], { edit_plan_id: null, owner_id: u1 });

  // strategy gates: exactly one subject, one gate per subject, owner-bound
  const gate = (cols, vals, owner = u1) => db.query(`insert into public.strategy_gates (owner_id, project_id${cols ? `, ${cols}` : ''}) values ('${owner}', '${projectId}'${vals ? `, ${vals}` : ''}) returning id`);
  await gate('concept_id, strategy_version_id, pillar_id, answers, joy_expected, within_boundaries, confirmed_at, fit_overrides', `'${pinned}', '${sv1}', 'werkstatt', '[{"criterionId": "werkstatt-f1", "answer": "ja"}]', 'ja', 'ja', now(), '[{"id": "o1", "key": "joy_unklar", "at": "2026-11-16T00:00:00Z", "hasReason": true}]'`);
  await assert.rejects(gate('concept_id', `'${pinned}'`), /strategy_gates_concept_key/);
  await assert.rejects(gate('', ''), /strategy_gates_one_subject/);
  await assert.rejects(gate('concept_id, root_edit_plan_id', `'${pinned}', '${p1}'`), /strategy_gates_one_subject/);
  await gate('root_edit_plan_id', `'${p1}'`); // lint-only gate of a free cut: no FitCheck yet
  await assert.rejects(gate('root_edit_plan_id, joy_expected', `'${freeV2}', 'vielleicht'`), /check constraint/);
  await assert.rejects(gate('concept_id', `'${pinned}'`, u2), /foreign key|violates/);
  await assert.rejects(db.exec(`delete from public.context_versions where id = '${sv1}'`), /owner_fkey/);

  // self-assessments: the note on the record (0010), session rows carry no subject, other subjects need „fertig“
  const sa = (cols, vals, owner = u1) => db.query(`insert into public.self_assessments (owner_id, joy${cols ? `, ${cols}` : ''}) values ('${owner}', ${vals}) returning id`);
  await sa('', '4');
  await sa('project_id, subject_kind, subject_id, finished, pillar_id, strategy_version_id, camera_comfort, note', `3, '${projectId}', 'publication', '${pub}', true, 'werkstatt', '${sv1}', 2, 'lief gut'`);
  await assert.rejects(sa('note', `3, '${'x'.repeat(1001)}'`), /check constraint/);
  await assert.rejects(sa('', '6'), /check constraint/);
  await assert.rejects(sa('', '0'), /check constraint/);
  await assert.rejects(sa('camera_comfort', '3, 6'), /check constraint/);
  await assert.rejects(sa('subject_id', `3, '${pub}'`), /self_assessments_subject/);
  await assert.rejects(sa('subject_kind, finished', `3, 'render', true`), /self_assessments_subject/);
  await assert.rejects(sa('subject_kind, subject_id', `3, 'render', '${pub}'`), /self_assessments_finished/);
  await assert.rejects(sa('project_id', `3, '${projectId}'`, u2), /foreign key|violates/);
  await assert.rejects(sa('strategy_version_id', `3, '${sv1}'`, u2), /foreign key|violates/);
  await assert.rejects(sa('finished', '3, true'), /self_assessments_finished/); // a session never counts as a finished piece
  await assert.rejects(sa('finished', '3, false'), /self_assessments_finished/);

  // a gate's subject must belong to the gate's own project (deleting one project never removes another's FitCheck)
  const otherProj = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Andere') returning id`)).rows[0].id;
  const otherConcept = (await db.query(`insert into public.concepts (owner_id, project_id, body) values ('${u1}', '${otherProj}', '{}') returning id`)).rows[0].id;
  const otherPlan = (await db.query(`insert into public.edit_plans (owner_id, project_id, body, version) values ('${u1}', '${otherProj}', '{}', 1) returning id`)).rows[0].id;
  await assert.rejects(gate('concept_id', `'${otherConcept}'`), /strategy_gates_concept_id_owner_fkey/);
  await assert.rejects(gate('root_edit_plan_id', `'${otherPlan}'`), /strategy_gates_root_edit_plan_id_owner_fkey/);

  // a profile whose version is pinned by a session check-in cannot be deleted (NO ACTION, check-ins are never
  // removed as a side effect); a profile whose versions nothing pins deletes together with its versions
  const pBlocked = (await db.query(`insert into public.creative_profiles (owner_id, name, profile_kind) values ('${u1}', 'Gesperrt', 'personal') returning id`)).rows[0].id;
  const vBlocked = (await cv(u1, pBlocked, 'strategy', 1, 'approved')).rows[0].id;
  await sa('strategy_version_id', `5, '${vBlocked}'`);
  await assert.rejects(db.exec(`delete from public.creative_profiles where id = '${pBlocked}'`), /self_assessments_strategy_version_id_owner_fkey/);
  const pUnpinned = (await db.query(`insert into public.creative_profiles (owner_id, name, profile_kind) values ('${u1}', 'Frei', 'personal') returning id`)).rows[0].id;
  await cv(u1, pUnpinned, 'strategy', 1, 'approved');
  await db.exec(`delete from public.creative_profiles where id = '${pUnpinned}'`);
  assert.equal((await db.query(`select count(*)::int as n from public.context_versions where profile_id = '${pUnpinned}'`)).rows[0].n, 0);

  // RLS on the three new tables
  for (const tbl of ['context_versions', 'strategy_gates', 'self_assessments']) {
    assert.ok((await asUser(u1, `select * from public.${tbl}`)).rows.length >= 1, `user 1 sees own ${tbl}`);
    assert.ok((await asUser(u2, `select * from public.${tbl} where owner_id = '${u1}'`)).rows.length === 0, `user 2 cannot see user 1's ${tbl}`);
  }
  await assert.rejects(asUser(u2, `insert into public.self_assessments (owner_id, joy) values ('${u1}', 3)`), /row-level security/);

  // deleting a whole user with pinned versions succeeds (NO ACTION is checked at the end of the cascade)
  const u3 = '33333333-3333-3333-3333-333333333333';
  await db.exec(`insert into auth.users values ('${u3}')`);
  const p3 = (await db.query(`insert into public.creative_profiles (owner_id, name, profile_kind) values ('${u3}', 'C', 'personal') returning id`)).rows[0].id;
  const v3 = (await cv(u3, p3, 'strategy', 1, 'approved')).rows[0].id;
  const proj3 = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u3}', '${p3}', 'PERSONAL_CONTENT', 'P') returning id`)).rows[0].id;
  const c3 = (await db.query(`insert into public.concepts (owner_id, project_id, body, strategy_version_id) values ('${u3}', '${proj3}', '{}', '${v3}') returning id`)).rows[0].id;
  await db.exec(`insert into public.strategy_gates (owner_id, project_id, concept_id, strategy_version_id) values ('${u3}', '${proj3}', '${c3}', '${v3}');
    insert into public.self_assessments (owner_id, strategy_version_id, joy) values ('${u3}', '${v3}', 5);
    insert into public.agent_runs (owner_id, project_id, agent_name, prompt_version, model, strategy_version_id, ai_context_hash) values ('${u3}', '${proj3}', 'content_strategist', 'p@2', 'mock', '${v3}', '${hash}');`);
  await db.exec(`delete from auth.users where id = '${u3}'`);
  for (const tbl of ['context_versions', 'concepts', 'strategy_gates', 'self_assessments', 'agent_runs']) {
    assert.equal((await db.query(`select count(*)::int as n from public.${tbl} where owner_id = '${u3}'`)).rows[0].n, 0, `no ${tbl} of the deleted user remain`);
  }

  // Etappe 14 (0011): her own fonts – owner-bound, upright only, licence note required, safe ASS name, unique per owner
  const font = (owner, profile, over = {}) => {
    const f = { name: 'Geist-Regular.ttf', format: 'ttf', family: 'Geist', postscript_name: 'Geist-Regular', ass_name: 'Geist Regular', weight: 400, italic: false, size_bytes: 1000, sha256: 'c'.repeat(64), storage_path: 'fonts/11111111-2222-3333-4444-555555555555.ttf', license: 'SIL OFL 1.1', ...over };
    return db.exec(`insert into public.fonts (owner_id, profile_id, ${Object.keys(f).join(', ')}) values ('${owner}', '${profile}', ${Object.values(f).map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(', ')})`);
  };
  await font(u1, pid);
  await assert.rejects(font(u1, pid), /fonts_sha256_key/);
  await assert.rejects(font(u1, pid, { sha256: 'd'.repeat(64), storage_path: 'fonts/11111111-2222-3333-4444-555555555556.ttf' }), /fonts_postscript_name_key/);
  for (const [over, why] of [[{ italic: true }, 'italic'], [{ license: '  ' }, 'license'], [{ ass_name: 'Böse,{x}' }, 'ass_name'], [{ format: 'woff' }, 'format'], [{ size_bytes: 10485761 }, 'size'], [{ storage_path: '../etc/passwd' }, 'path']])
    await assert.rejects(font(u1, pid, { sha256: 'e'.repeat(64), postscript_name: `X-${why}`, storage_path: 'fonts/11111111-2222-3333-4444-555555555557.ttf', ...over }), /check constraint/, why);
  await assert.rejects(font(u1, pid2, { sha256: 'f'.repeat(64), postscript_name: 'Other' }), /foreign key|violates/);
  assert.equal((await asUser(u2, `select * from public.fonts`)).rows.length, 0);
  await assert.rejects(asUser(u2, `insert into public.fonts (owner_id, profile_id, name, format, family, postscript_name, ass_name, weight, size_bytes, sha256, storage_path, license) values ('${u1}', '${pid}', 'x', 'ttf', 'X', 'X', 'X', 400, 1, '${'a'.repeat(64)}', 'fonts/11111111-2222-3333-4444-555555555558.ttf', 'OFL')`), /row-level security/);

  // Etappe 16b (0016): font origin – existing rows are uploads; a Google font needs family, versioned gstatic URL and licence
  {
    assert.equal((await db.query(`select origin_kind from public.fonts where owner_id = '${u1}' limit 1`)).rows[0].origin_kind, 'upload');
    const g = { sha256: '1'.repeat(64), postscript_name: 'BebasNeue-Regular', storage_path: 'fonts/11111111-2222-3333-4444-555555555590.ttf', origin_kind: 'google', google_family: 'Bebas Neue', source_url: 'https://fonts.gstatic.com/s/bebasneue/v16/JTUSjIg69CK48gW7PXooxW4.ttf', license_id: 'OFL-1.1', license_url: 'https://openfontlicense.org' };
    await font(u1, pid, g);
    for (const [over, why] of [[{ source_url: 'http://fonts.gstatic.com/s/x/v1/a.ttf' }, 'http'], [{ source_url: 'https://evil.example/s/x/v1/a.ttf' }, 'host'], [{ license_id: 'proprietary' }, 'licence'], [{ google_family: null }, 'family'], [{ origin_kind: 'upload' }, 'upload with google fields']])
      await assert.rejects(font(u1, pid, { ...g, sha256: '2'.repeat(64), postscript_name: `G-${why.replace(/ /g, '')}`, storage_path: 'fonts/11111111-2222-3333-4444-555555555591.ttf', ...over }), /check constraint|violates/, why);
  }

  // Etappe 12 (0012): one working draft per project and base, owner-bound, RLS; footage keeps its derived media
  const pEd = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Editor') returning id`)).rows[0].id;
  const draft = (proj, extra = '') => db.exec(`insert into public.edit_drafts (owner_id, project_id, body${extra ? ', ' + extra.split('=')[0] : ''}) values ('${u1}', '${proj}', '{"clips":[]}'${extra ? ', ' + extra.split('=')[1] : ''})`);
  await draft(pEd);
  await assert.rejects(draft(pEd), /edit_drafts_one_per_base/); // a second free-cut draft of the same project
  await assert.rejects(db.exec(`insert into public.edit_drafts (owner_id, project_id, body) values ('${u1}', '${pEd}', '{"clips":{}}')`), /check constraint/);
  await assert.rejects(db.exec(`insert into public.edit_drafts (owner_id, project_id, body) values ('${u2}', '${pEd}', '{"clips":[]}')`), /foreign key|violates/); // another owner's project
  assert.equal((await asUser(u2, `select * from public.edit_drafts`)).rows.length, 0);
  await assert.rejects(asUser(u2, `insert into public.edit_drafts (owner_id, project_id, body) values ('${u1}', '${pEd}', '{"clips":[]}')`), /row-level security/);
  await db.exec(`update public.assets set derived = '{"version":1}' where owner_id = '${u1}'`);
  await assert.rejects(db.exec(`update public.assets set derived = '[]' where owner_id = '${u1}'`), /check constraint/);
  await db.exec(`delete from public.projects where id = '${pEd}'`);
  assert.equal((await db.query(`select count(*)::int as n from public.edit_drafts where project_id = '${pEd}'`)).rows[0].n, 0, 'draft goes with its project');

  // Etappe 15 (0013): chat threads per page scope and messages with typed proposals; owner-bound, RLS
  const pChat = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Chat') returning id`)).rows[0].id;
  const thread = async (owner, scope, project = null) => (await db.query(`insert into public.chat_threads (owner_id, scope, project_id) values ('${owner}', '${scope}', ${project ? `'${project}'` : 'null'}) returning id`)).rows[0].id;
  const tBrand = await thread(u1, 'brand');
  const tEd = await thread(u1, `editor:${pChat}`, pChat);
  await assert.rejects(thread(u1, 'render'), /check constraint/);
  await assert.rejects(thread(u1, `editor:${pChat}`), /chat_threads_scope_project/); // editor scope without its project
  await assert.rejects(thread(u1, 'brand', pChat), /chat_threads_scope_project/);
  await assert.rejects(thread(u2, `editor:${pChat}`, pChat), /foreign key|violates/); // another owner's project
  const msg = (owner, th, role, extra = {}) => {
    const f = { body: 'mach den Akzent wärmer', proposals: '[]', ...extra };
    return db.exec(`insert into public.chat_messages (owner_id, thread_id, role, ${Object.keys(f).join(', ')}) values ('${owner}', '${th}', '${role}', ${Object.values(f).map((v) => `'${v}'`).join(', ')})`);
  };
  await msg(u1, tBrand, 'user');
  await msg(u1, tBrand, 'assistant', { proposals: '[{"kind":"design","status":"open","patch":{"kind":"design","ops":[]}}]', mock: 'true' });
  await assert.rejects(msg(u1, tBrand, 'assistant', { proposals: '[{"kind":"render","status":"open"}]' }), /chat_messages_proposal_kinds/);
  await assert.rejects(msg(u1, tBrand, 'assistant', { proposals: '[{"kind":"design","status":"done"}]' }), /chat_messages_proposal_status/);
  for (const bad of ['{"kind":1,"status":"open"}', '{"kind":{"a":1},"status":"open"}', '{"status":"open"}', '{"kind":"design","status":true}', '{"kind":"design"}'])
    await assert.rejects(msg(u1, tBrand, 'assistant', { proposals: `[${bad}]` }), /chat_messages_proposal_(kinds|status)/, bad);
  await assert.rejects(msg(u1, tBrand, 'user', { proposals: '[{"kind":"design","status":"open"}]' }), /chat_messages_role_fields/);
  await assert.rejects(msg(u1, tBrand, 'assistant', { image_ids: '{11111111-2222-3333-4444-555555555555}' }), /chat_messages_user_images/);
  await assert.rejects(msg(u1, tBrand, 'user', { image_ids: `{${Array.from({ length: 5 }, (_, i) => `11111111-2222-3333-4444-55555555555${i}`).join(',')}}` }), /check constraint/);
  await assert.rejects(msg(u1, tBrand, 'user', { body: '' }), /check constraint/);
  await assert.rejects(msg(u2, tBrand, 'user'), /foreign key|violates/); // another owner's thread
  assert.equal((await asUser(u2, `select * from public.chat_threads`)).rows.length, 0);
  assert.equal((await asUser(u2, `select * from public.chat_messages`)).rows.length, 0);
  await assert.rejects(asUser(u2, `insert into public.chat_threads (owner_id, scope) values ('${u1}', 'general')`), /row-level security/);
  assert.equal((await asUser(u1, `select * from public.chat_messages`)).rows.length, 2);
  await msg(u1, tEd, 'user');
  await db.exec(`delete from public.projects where id = '${pChat}'`);
  assert.equal((await db.query(`select count(*)::int as n from public.chat_threads where id = '${tEd}'`)).rows[0].n, 0, 'editor thread goes with its project');
  assert.equal((await db.query(`select count(*)::int as n from public.chat_messages where thread_id = '${tEd}'`)).rows[0].n, 0, 'its messages too');
  // a strategy version taken over from a chat proposal
  await db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values ('${u1}', '${pid}', 'strategy', 90, 'archived', '{}', '${hash}', 'chat', now())`);
  await assert.rejects(db.exec(`insert into public.context_versions (owner_id, profile_id, kind, version, status, document, ai_text_hash, source, approved_at) values ('${u1}', '${pid}', 'strategy', 91, 'archived', '{}', '${hash}', 'robot', now())`), /context_versions_source_check/);

  // Etappe 16 (0014): story plans (owner-bound, RLS, with the project), chat proposals of kind `story`, references.usage
  const pStory = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Story') returning id`)).rows[0].id;
  const dStory = (await db.query(`insert into public.edit_drafts (owner_id, project_id, body) values ('${u1}', '${pStory}', '{"clips":[]}') returning id`)).rows[0].id;
  const story = (owner, project, body = '{"beats":[],"hooks":[],"sentences":[]}', draft = dStory) =>
    db.query(`insert into public.story_plans (owner_id, project_id, draft_id, draft_revision, prompt_version, mock, provider, model, body) values ('${owner}', '${project}', ${draft ? `'${draft}'` : 'null'}, 1, 'edit-director@1', true, 'mock', 'mock', '${body}') returning id`);
  const sp = (await story(u1, pStory)).rows[0].id;
  await assert.rejects(story(u1, pStory, '{"beats":[]}'), /check constraint/); // no hooks/sentences
  await assert.rejects(story(u1, pStory, `{"beats":[],"sentences":[],"hooks":[${Array(7).fill('{}').join(',')}]}`), /check constraint/); // more than six hooks
  await assert.rejects(story(u2, pStory, undefined, null), /foreign key|violates/); // another owner's project
  assert.equal((await asUser(u2, `select * from public.story_plans`)).rows.length, 0);
  await assert.rejects(asUser(u2, `insert into public.story_plans (owner_id, project_id, draft_revision, prompt_version, provider, model, body) values ('${u1}', '${pStory}', 1, 'x', 'mock', 'mock', '{"beats":[],"hooks":[],"sentences":[]}')`), /row-level security/);
  assert.equal((await asUser(u1, `select * from public.story_plans`)).rows.length, 1);
  await db.exec(`delete from public.edit_drafts where id = '${dStory}'`);
  assert.equal((await db.query(`select draft_id from public.story_plans where id = '${sp}'`)).rows[0].draft_id, null, 'the draft reference is cleared with the draft');
  await db.exec(`delete from public.projects where id = '${pStory}'`);
  assert.equal((await db.query(`select count(*)::int as n from public.story_plans where id = '${sp}'`)).rows[0].n, 0, 'story plans go with their project');
  const tStory = await thread(u1, 'general');
  await msg(u1, tStory, 'assistant', { proposals: '[{"kind":"story","status":"open"}]' });
  const refId = (await db.query(`insert into public.references (owner_id, profile_id, media_kind) values ('${u1}', '${pid}', 'image') returning id`)).rows[0].id;
  {
    await db.exec(`update public.references set usage = '{"origin":"own","source":""}' where id = '${refId}'`);
    await db.exec(`update public.references set usage = '{"origin":"licensed","source":"CC BY 4.0"}' where id = '${refId}'`);
    await assert.rejects(db.exec(`update public.references set usage = '{"origin":"licensed","source":""}' where id = '${refId}'`), /check constraint/);
    await assert.rejects(db.exec(`update public.references set usage = '{"origin":"stolen"}' where id = '${refId}'`), /check constraint/);
    await assert.rejects(db.exec(`update public.references set usage = '{"source":"x"}' where id = '${refId}'`), /check constraint/);
  }

  // Etappe 17 (0015): renders.finish – the four known package files with path and size, the QA result capped
  {
    const planId = (await db.query(`insert into public.edit_plans (owner_id, project_id, body, version) values ('${u1}', (select id from public.projects where owner_id = '${u1}' limit 1), '{}', 917) returning id`)).rows[0].id;
    const rId = (await db.query(`insert into public.renders (owner_id, edit_plan_id) values ('${u1}', '${planId}') returning id`)).rows[0].id;
    const set = (v) => db.exec(`update public.renders set finish = '${v}' where id = '${rId}'`);
    await set('{"files":{}}');
    await set('{"files":{"clean":{"storagePath":"renders/p/finish/r/video-clean.mp4","size":12,"sha256":"x","createdAt":"t"},"cover":{"storagePath":"c.png","size":1}},"qa":null}');
    await set(`{"files":{},"qa":{"findings":[{"text":"mit","startSec":1.5}],"expected":7}}`);
    await assert.rejects(set('{"files":{"video":{"storagePath":"x","size":1}}}'), /check constraint/); // unknown file
    await assert.rejects(set('{"files":{"clean":{"storagePath":1,"size":1}}}'), /check constraint/); // path not a string
    await assert.rejects(set('{"files":{"clean":{"storagePath":"x","size":-1}}}'), /check constraint/);
    await assert.rejects(set('{"qa":null}'), /check constraint/); // files missing
    await assert.rejects(set(`{"files":{},"qa":{"findings":[${Array(201).fill('{}').join(',')}]}}`), /check constraint/);
    await assert.rejects(set('[]'), /check constraint/);
    assert.equal((await asUser(u2, `select * from public.renders where id = '${rId}'`)).rows.length, 0, 'another owner cannot see the package record');
  }

  // Etappe 18 (0017): carousels with versions (one active), owner-bound, RLS, with their project; chat threads/proposals
  {
    const pCar = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Karussell') returning id`)).rows[0].id;
    const car = async (owner, extra = {}) => {
      const f = { project_id: pCar, title: 'Morgenstricken', source_kind: 'note', source_label: 'Notiz', ...extra };
      return (await db.query(`insert into public.carousels (owner_id, ${Object.keys(f).join(', ')}) values ('${owner}', ${Object.values(f).map((v) => (v === null ? 'null' : `'${v}'`)).join(', ')}) returning id`)).rows[0].id;
    };
    const cId = await car(u1);
    await assert.rejects(car(u1, { source_kind: 'tweet' }), /check constraint/);
    await assert.rejects(car(u1, { title: '' }), /check constraint/);
    await assert.rejects(car(u1, { source_kind: 'note', source_script_id: '11111111-2222-3333-4444-555555555555' }), /check constraint|foreign key|violates/);
    await assert.rejects(car(u2), /foreign key|violates/); // another owner's project
    const slides = (n, kind = 'text') => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, kind })));
    const body = (over = {}) => JSON.stringify({ format: 'portrait', templateId: 'klar', caption: '', slides: JSON.parse(slides(3)), ...over });
    const ver = (n, status, extra = {}) => {
      const f = { carousel_id: cId, version: n, status, origin: 'user_edit', body: body(), ...extra };
      return db.query(`insert into public.carousel_versions (owner_id, ${Object.keys(f).join(', ')}) values ('${u1}', ${Object.values(f).map((v) => (v === null ? 'null' : `'${v}'`)).join(', ')}) returning id`);
    };
    const v1 = (await ver(1, 'active', { origin: 'agent', prompt_version: 'carousel-writer@1', mock: 'true' })).rows[0].id;
    await assert.rejects(ver(2, 'active'), /carousel_versions_one_active/); // a second active version
    await ver(2, 'archived', { parent_id: v1 });
    await assert.rejects(ver(2, 'archived'), /carousel_versions_number_key/);
    await assert.rejects(ver(3, 'archived', { origin: 'agent' }), /carousel_versions_agent_fields/); // a generated version names its prompt
    for (const [b, why] of [[body({ slides: JSON.parse(slides(1)) }), 'one slide'], [body({ slides: JSON.parse(slides(11)) }), 'eleven'], [body({ format: 'story' }), 'format'],
      [body({ templateId: 'fremd' }), 'template'], [body({ slides: JSON.parse(slides(3, 'video')) }), 'kind'], [body({ caption: 'x'.repeat(2201) }), 'caption'], [JSON.stringify({ slides: JSON.parse(slides(3)) }), 'no format']])
      await assert.rejects(ver(9, 'archived', { body: b }), /check constraint/, why);
    await assert.rejects(ver(9, 'archived', { origin: 'robot' }), /check constraint/);
    assert.equal((await asUser(u2, `select * from public.carousels`)).rows.length, 0);
    assert.equal((await asUser(u2, `select * from public.carousel_versions`)).rows.length, 0);
    await assert.rejects(asUser(u2, `insert into public.carousels (owner_id, project_id, title, source_kind, source_label) values ('${u1}', '${pCar}', 'x', 'note', 'x')`), /row-level security/);
    // chat: a carousel thread carries its carousel and that carousel's project; proposals of kind `carousel`
    const tc = (scope, project, carousel) => db.query(`insert into public.chat_threads (owner_id, scope, project_id, carousel_id) values ('${u1}', '${scope}', ${project ? `'${project}'` : 'null'}, ${carousel ? `'${carousel}'` : 'null'}) returning id`);
    const tCar = (await tc(`carousel:${cId}`, pCar, cId)).rows[0].id;
    await assert.rejects(tc(`carousel:${cId}`, null, cId), /chat_threads_scope_project/);
    await assert.rejects(tc(`carousel:${cId}`, pCar, null), /chat_threads_scope_project/); // a carousel thread without its carousel
    await assert.rejects(tc('general', null, cId), /chat_threads_scope_project/);
    const pOther = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Anderes') returning id`)).rows[0].id;
    await assert.rejects(tc(`carousel:${cId}`, pOther, cId), /chat_threads_carousel_fk|foreign key|violates/); // not the carousel's project
    await msg(u1, tCar, 'assistant', { proposals: '[{"kind":"carousel","status":"open"}]' });
    await db.exec(`delete from public.projects where id = '${pCar}'`);
    assert.equal((await db.query(`select count(*)::int as n from public.carousels where id = '${cId}'`)).rows[0].n, 0, 'carousels go with their project');
    assert.equal((await db.query(`select count(*)::int as n from public.carousel_versions where carousel_id = '${cId}'`)).rows[0].n, 0, 'and their versions');
    assert.equal((await db.query(`select count(*)::int as n from public.chat_threads where id = '${tCar}'`)).rows[0].n, 0, 'and their chat threads');
  }

  // Etappe 19 (0018): stories – owner-bound, RLS, with their project; body shape (kinds, media, clip ≤ 15 s, text lengths)
  {
    const pSt = (await db.query(`insert into public.projects (owner_id, profile_id, project_kind, title) values ('${u1}', '${pid}', 'PERSONAL_CONTENT', 'Stories') returning id`)).rows[0].id;
    const body = (over = {}) => JSON.stringify({ kind: 'teaser', media: { kind: 'none' }, kicker: 'Neues Reel', title: 'Morgenstricken', body: '', sticker: { kind: 'none' }, ...over });
    const st = (owner, extra = {}) => {
      const f = { project_id: pSt, batch_id: '11111111-0000-0000-0000-0000000000b1', title: 'Teaser', source_kind: 'note', source_label: 'Notiz', origin: 'manual', body: body(), ...extra };
      return db.query(`insert into public.stories (owner_id, ${Object.keys(f).join(', ')}) values ('${owner}', ${Object.values(f).map((v) => (v === null ? 'null' : `'${v}'`)).join(', ')}) returning id`);
    };
    const sId = (await st(u1)).rows[0].id;
    await st(u1, { origin: 'agent', prompt_version: 'story-writer@1', mock: 'true', body: body({ media: { kind: 'clip', source: 'render', id: 'r', startSec: 0, durationSec: 15 } }) });
    await assert.rejects(st(u1, { origin: 'agent' }), /stories_agent_fields/);
    for (const [b, why] of [[body({ kind: 'reel' }), 'kind'], [body({ media: { kind: 'clip', durationSec: 16 } }), 'clip > 15 s'], [body({ media: { kind: 'video' } }), 'media'],
      [body({ title: 'x'.repeat(141) }), 'title'], [body({ sticker: { kind: 'countdown' } }), 'sticker'], [JSON.stringify({ kind: 'teaser' }), 'no media']])
      await assert.rejects(st(u1, { body: b }), /check constraint/, why);
    await assert.rejects(st(u1, { source_kind: 'tweet' }), /check constraint/);
    await assert.rejects(st(u1, { source_kind: 'note', source_concept_id: '11111111-2222-3333-4444-555555555555' }), /check constraint|foreign key|violates/);
    await assert.rejects(st(u1, { render: '{"storagePath":"x","mime":"image/gif"}' }), /check constraint/);
    await assert.rejects(st(u2), /foreign key|violates/); // another owner's project
    assert.equal((await asUser(u2, `select * from public.stories`)).rows.length, 0);
    await assert.rejects(asUser(u2, `insert into public.stories (owner_id, project_id, batch_id, title, source_kind, source_label, origin, body) values ('${u1}', '${pSt}', gen_random_uuid(), 'x', 'note', 'x', 'manual', '${body()}')`), /row-level security/);

    // Etappe 20 (0019): board items (no scheduling/alarm columns), week plans, chat scope `week`
    const cols = (await db.query(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'board_items'`)).rows.map((r) => r.column_name);
    assert.ok(!cols.some((c) => /schedul|remind|alarm|publish_at|auto/.test(c)), `no scheduling/reminder columns: ${cols.join(',')}`);
    const item = (owner, extra = {}) => {
      const f = { day: '2026-11-20', slot: 'main', kind: 'reel', title: 'Reel', status: 'idea', origin: 'manual', ...extra };
      return db.query(`insert into public.board_items (owner_id, ${Object.keys(f).join(', ')}) values ('${owner}', ${Object.values(f).map((v) => (v === null ? 'null' : `'${v}'`)).join(', ')}) returning id`);
    };
    const bId = (await item(u1, { project_id: pSt, ref_kind: 'story', ref_story_id: sId, kind: 'story', slot: 'story' })).rows[0].id;
    await item(u1, { day: null, kind: 'idea', title: 'Ohne Tag' });
    await item(u1, { status: 'posted', posted_at: '2026-11-20', permalink: 'https://www.instagram.com/p/x/' });
    await assert.rejects(item(u1, { kind: 'story' }), /board_items_slot_kind/); // a story in the main slot
    await assert.rejects(item(u1, { status: 'posted' }), /board_items_posted/); // posted without a date
    await assert.rejects(item(u1, { posted_at: '2026-11-20' }), /board_items_posted/); // a date without „posted“
    await assert.rejects(item(u1, { status: 'posted', posted_at: '2026-11-20', permalink: 'javascript:alert(1)' }), /check constraint/);
    await assert.rejects(item(u1, { ref_kind: 'carousel', ref_story_id: sId }), /board_items_ref/);
    await assert.rejects(item(u1, { status: 'scheduled' }), /check constraint/);
    await assert.rejects(item(u1, { pillar_id: 'Nicht Gültig' }), /check constraint/);
    await assert.rejects(item(u2, { project_id: pSt }), /foreign key|violates/);
    assert.equal((await asUser(u2, `select * from public.board_items`)).rows.length, 0);
    const plan = (extra = {}) => {
      const f = { week_start: '2026-11-16', prompt_version: 'week-planner@1', suggestions: '[{"kind":"reel","status":"open"}]', ...extra };
      return db.query(`insert into public.week_plans (owner_id, ${Object.keys(f).join(', ')}) values ('${u1}', ${Object.values(f).map((v) => `'${v}'`).join(', ')}) returning id`);
    };
    await plan();
    await assert.rejects(plan({ week_start: '2026-11-18' }), /check constraint/); // not a Monday
    await assert.rejects(plan({ suggestions: '[{"kind":"post","status":"open"}]' }), /check constraint/);
    await assert.rejects(plan({ suggestions: '[{"kind":"reel","status":"posted"}]' }), /check constraint/);
    const tw = (await db.query(`insert into public.chat_threads (owner_id, scope) values ('${u1}', 'week') returning id`)).rows[0].id;
    await msg(u1, tw, 'assistant', { proposals: '[{"kind":"week","status":"open"}]' });
    await assert.rejects(msg(u1, tw, 'assistant', { proposals: '[{"kind":"post","status":"open"}]' }), /chat_messages_proposal_kinds/);
    await assert.rejects(db.query(`insert into public.chat_threads (owner_id, scope, project_id) values ('${u1}', 'week', '${pSt}')`), /chat_threads_scope_project/);
    // deleting the story leaves the board entry (link nulled); deleting the project removes stories, keeps entries without project
    await db.exec(`delete from public.stories where id = '${sId}'`);
    assert.deepEqual((await db.query(`select ref_story_id, project_id from public.board_items where id = '${bId}'`)).rows[0], { ref_story_id: null, project_id: pSt });
    await db.exec(`delete from public.projects where id = '${pSt}'`);
    assert.equal((await db.query(`select count(*)::int as n from public.stories where project_id = '${pSt}'`)).rows[0].n, 0, 'stories go with their project');
    assert.equal((await db.query(`select project_id from public.board_items where id = '${bId}'`)).rows[0].project_id, null, 'board entries stay without the project');
  }

  // storage bucket is private and policies scope objects to <uid>/...
  assert.equal((await db.query(`select public from storage.buckets where id = 'creative-media'`)).rows[0].public, false);
  await asUser(u1, `insert into storage.objects (bucket_id, name, owner) values ('creative-media', '${u1}/media/a.png', '${u1}')`);
  await assert.rejects(asUser(u1, `insert into storage.objects (bucket_id, name, owner) values ('creative-media', '${u2}/media/b.png', '${u1}')`), /row-level security/);
  assert.equal((await asUser(u2, `select * from storage.objects`)).rows.length, 0);
  await db.close();
});
