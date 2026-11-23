import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Etappe 12 (E7): working draft with autosave, lenient problems, conflict check, snapshot + render. */
const run = promisify(execFile);
let dir: string;
let ff: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-draft-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock', TRANSCRIPTION: 'mock' });
  ff = (await (await import('@/server/ffmpeg')).ffmpegPath())!;
});
afterAll(async () => {
  delete process.env.TRANSCRIPTION;
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function clip(seconds = 4) {
  const out = path.join(dir, `take-${Math.random().toString(36).slice(2)}.mp4`);
  await run(ff, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-shortest', '-y', out]);
  return new Blob([await readFile(out)]).stream();
}
async function until<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 120000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const x = await fn();
    if (ok(x)) return x;
    if (Date.now() - t0 > ms) throw new Error(`Timeout: ${JSON.stringify(x).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function setup(kind: 'PERSONAL_CONTENT' | 'UGC_CLIENT' = 'PERSONAL_CONTENT') {
  const projects = await import('@/server/services/projects');
  const footage = await import('@/server/services/footage');
  const project = await projects.createProject(kind === 'UGC_CLIENT' ? { title: 'Kunde', kind, client: { clientName: 'Garn GmbH', productClaims: [] } } : { title: 'Entwurf', kind });
  const { asset } = await footage.uploadFootage(project.id, await clip(), kind === 'UGC_CLIENT' ? { name: 'k.mp4', origin: 'client', rightsConfirmed: true, rightsNote: 'Vertrag vom 1.11.' } : { name: 'take.mp4', origin: 'own' }, null);
  return { project, assetId: asset.id };
}

describe('working draft (edit-draft)', () => {
  it('autosave → reload keeps everything; problems are shown, not refused; conflicting saves get 409', async () => {
    const drafts = await import('@/server/services/editDraft');
    const { forgetCacheForTests } = await import('@/server/store');
    const { project, assetId } = await setup();
    const empty = await drafts.getEditDraft(project.id, null);
    expect(empty).toMatchObject({ draft: null, issues: null, projectKind: 'PERSONAL_CONTENT', etag: '"r0"' });
    expect(empty.media.map((m) => m.id)).toEqual([assetId]);

    // an empty draft and a draft with problems are stored (lenient): no 400
    const v1 = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [] } });
    expect(v1.draft!.revision).toBe(1);
    expect(v1.issues!.errors).toEqual(['Noch kein Clip im Schnitt.']);
    const bad = { clips: [{ assetId, inSec: 0, outSec: 9 }, { assetId: 'gone', inSec: 0, outSec: 1 }] };
    const v2 = await drafts.putEditDraft(project.id, { scriptId: null, revision: 1, body: bad });
    expect(v2.draft!.revision).toBe(2);
    expect(v2.issues!.errors.join(' ')).toMatch(/hinter dem Ende des Footage/);
    expect(v2.issues!.errors.join(' ')).toMatch(/Footage nicht gefunden/);

    const good = { clips: [{ assetId, inSec: 0.5, outSec: 3.5, cuts: [{ startSec: 1.2, endSec: 1.6 }] }], hook: { source: 'free', text: 'Mein Morgen' }, loudness: 'off' };
    const v3 = await drafts.putEditDraft(project.id, { scriptId: null, revision: 2, body: good }, '"r2"');
    expect(v3.issues).toMatchObject({ errors: [] });
    expect(v3.issues!.durationSec).toBeCloseTo(2.6, 1);
    // a stale tab (still on revision 2) is refused with a conflict, nothing is lost
    await expect(drafts.putEditDraft(project.id, { scriptId: null, revision: 2, body: { clips: [] } })).rejects.toMatchObject({ status: 409, code: 'draft_conflict' });
    await expect(drafts.putEditDraft(project.id, { scriptId: null, revision: 3, body: { clips: [] } }, '"r1"')).rejects.toMatchObject({ status: 409 }); // If-Match wins
    // shape errors are still a 400 (programming error, not content)
    await expect(drafts.putEditDraft(project.id, { scriptId: null, revision: 3, body: { clips: [{ assetId, inSec: -1, outSec: 1 }] } })).rejects.toThrow();

    // „reload“: a new process reads the same draft from disk
    forgetCacheForTests();
    vi.resetModules();
    const fresh = await import('@/server/services/editDraft');
    const back = await fresh.getEditDraft(project.id, '');
    expect(back.draft).toMatchObject({ revision: 3, body: { clips: [{ assetId, inSec: 0.5, outSec: 3.5, cuts: [{ startSec: 1.2, endSec: 1.6, reason: 'manual' }] }], hook: { text: 'Mein Morgen' } } });
    expect(back.etag).toBe('"r3"');
  });

  it('render from the draft: an immutable EditPlan snapshot (strict validation) + a render job; the same revision is not snapshotted twice; old plans stay', async () => {
    const drafts = await import('@/server/services/editDraft');
    const edit = await import('@/server/services/edit');
    const { getJob } = await import('@/server/services/videoJobs');
    const { read } = await import('@/server/store');
    const { project, assetId } = await setup();
    // an older saved version: the draft continues it, it is never changed
    const old = await edit.saveEditPlan(project.id, { scriptId: null, body: { clips: [{ assetId, inSec: 0, outSec: 2 }], loudness: 'off' } });
    const seeded = await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [{ assetId, inSec: 0, outSec: 3, cuts: [{ startSec: 1, endSec: 1.5 }] }], loudness: 'off' }, basePlanId: old.id });
    expect(seeded.draft!.basePlanId).toBe(old.id);

    // a draft with problems does not render: 400 with the problems, no version
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 1, body: { clips: [{ assetId, inSec: 0, outSec: 30 }], loudness: 'off' } });
    await expect(drafts.renderEditDraft(project.id, { scriptId: null, revision: 2 })).rejects.toThrow(/hinter dem Ende/);
    expect(await read((db) => db.editPlans.filter((p) => p.projectId === project.id).length)).toBe(1);
    // rendering an older revision than stored: 409
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 2, body: { clips: [{ assetId, inSec: 0, outSec: 3, cuts: [{ startSec: 1, endSec: 1.5 }] }], loudness: 'off' } });
    await expect(drafts.renderEditDraft(project.id, { scriptId: null, revision: 2 })).rejects.toMatchObject({ status: 409 });

    const out = await drafts.renderEditDraft(project.id, { scriptId: null, revision: 3 });
    expect(out.plan).toMatchObject({ scriptId: null, version: 2, parentId: old.id, status: 'approved' }); // personal: implicit approval
    expect(out.job).toMatchObject({ kind: 'render' });
    const done = await until(() => getJob(out.job!.id), (j) => j.status !== 'queued' && j.status !== 'running');
    expect(done.error).toBeNull();
    const r = await read((db) => db.renders.find((x) => x.jobId === out.job!.id)!);
    expect(r.status).toBe('pending_review');
    expect(r.durationSec).toBeCloseTo(2.5, 1);
    // the draft stays the working state, its lineage moved on
    const after = await drafts.getEditDraft(project.id, null);
    expect(after.draft).toMatchObject({ revision: 3, basePlanId: out.plan.id });
    expect(after.snapshot).toMatchObject({ planId: out.plan.id, version: 2, revision: 3 });
    expect(after.renders[0]).toMatchObject({ editPlanId: out.plan.id, status: 'pending_review', planVersion: 2 });
    // clicking again on the same revision: same version, same render (idempotency key)
    const again = await drafts.renderEditDraft(project.id, { scriptId: null, revision: 3 });
    expect(again.plan.id).toBe(out.plan.id);
    expect(again.job!.id).toBe(out.job!.id);
    expect(again.replayed).toBe(true);
    // the old version is untouched
    expect(await read((db) => db.editPlans.find((p) => p.id === old.id)!)).toMatchObject({ status: 'draft', version: 1, body: { clips: [{ inSec: 0, outSec: 2 }] } });
  }, 180000);

  it('client projects: no free-cut draft, no render from the editor (only „save“ as a draft version for the existing approval)', async () => {
    const drafts = await import('@/server/services/editDraft');
    const content = await import('@/server/services/content');
    const { read, write, newId, now } = await import('@/server/store');
    const { project, assetId } = await setup('UGC_CLIENT');
    await expect(drafts.getEditDraft(project.id, null)).rejects.toMatchObject({ status: 409 });
    await expect(drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [] } })).rejects.toMatchObject({ status: 409 });
    void content;
    // a script of the project (stored directly, the script flow is tested elsewhere)
    const scriptId = newId();
    await write((db) => {
      db.scripts.push({
        id: scriptId, projectId: project.id, conceptId: 'c', version: 1, parentId: null, source: 'agent', agentRunId: null, promptVersion: null, status: 'draft',
        body: { title: 'T', hook: 'H', selectedHook: 'H', hookVariants: [], scenes: [{ index: 0, durationSec: 3, shotType: 'talking_head', origin: 'real', dialogue: 'Hallo', onScreenText: '', visual: '', audio: '' }], cta: '', verifiedClaims: [], claimsToVerify: [], disclosure: 'Anzeige', notes: '' } as never,
        styleBibleVersionId: null, voiceGuideVersionId: null, mock: true, createdAt: now(), approvedAt: null,
      });
    });
    const v = await drafts.putEditDraft(project.id, { scriptId, revision: 0, body: { clips: [{ sceneIndex: 0, assetId, inSec: 0, outSec: 2 }], loudness: 'off' } });
    expect(v.projectKind).toBe('UGC_CLIENT');
    await expect(drafts.renderEditDraft(project.id, { scriptId, revision: 1 })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Freigabe/) });
    const saved = await drafts.renderEditDraft(project.id, { scriptId, revision: 1, mode: 'save' });
    expect(saved).toMatchObject({ job: null, render: null, plan: { status: 'draft', scriptId } });
    expect(await read((db) => db.renders.filter((r) => r.projectId === project.id).length)).toBe(0);
  });

  it('deleting footage removes its clips from the working draft (new revision); deleting the project removes the draft', async () => {
    const drafts = await import('@/server/services/editDraft');
    const footage = await import('@/server/services/footage');
    const projects = await import('@/server/services/projects');
    const { read } = await import('@/server/store');
    const { project, assetId } = await setup();
    await drafts.putEditDraft(project.id, { scriptId: null, revision: 0, body: { clips: [{ assetId, inSec: 0, outSec: 2 }] } });
    await footage.deleteFootage(assetId);
    const v = await drafts.getEditDraft(project.id, null);
    expect(v.draft).toMatchObject({ revision: 2, body: { clips: [] } });
    await projects.deleteProject(project.id);
    expect(await read((db) => db.editDrafts.some((d) => d.projectId === project.id))).toBe(false);
  });
});
