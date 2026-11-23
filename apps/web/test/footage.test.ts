import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-footage-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock' });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/** An MP4 `ftyp` header followed by `total` bytes in 1 MB chunks – a stream, never one big buffer. */
function mp4Stream(total: number, seed = 0): ReadableStream<Uint8Array> {
  const ftyp = new Uint8Array([0, 0, 0, 0x18, ...Buffer.from('ftypisom'), 0, 0, 2, 0, ...Buffer.from('isomiso2')]);
  let sent = 0;
  return new ReadableStream({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(1024 * 1024, total - sent);
      const chunk = new Uint8Array(n).fill(seed);
      if (sent === 0) chunk.set(ftyp);
      sent += n;
      c.enqueue(chunk);
    },
  });
}
const bytesStream = (b: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } });
const meta = (extra: Record<string, unknown> = {}) => ({ name: 'take1.mov', origin: 'own', rightsConfirmed: true, ...extra });
const files = async (projectId: string) => readdir(path.join(dir, 'footage', projectId)).catch(() => [] as string[]);

describe('Footage upload (Release 3, Etappe 2)', () => {
  it('streams files above the old 60 MB limit to disk with hash, provenance and a probe status', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const p = await projects.createProject({ title: 'Reel', kind: 'PERSONAL_CONTENT' });
    const { asset, duplicate } = await footage.uploadFootage(p.id, mp4Stream(70 * 1024 * 1024), meta(), null);
    expect(duplicate).toBe(false);
    expect(asset).toMatchObject({ projectId: p.id, mime: 'video/mp4', size: 70 * 1024 * 1024, origin: 'own', name: 'take1.mov' });
    expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(['probe_failed', 'probe_unavailable']).toContain(asset.status); // not a real video
    expect((await stat(path.join(dir, asset.storagePath))).size).toBe(70 * 1024 * 1024);
    expect(await files(p.id)).toEqual([path.basename(asset.storagePath)]); // no .part left behind

    // same content again → existing asset, new file removed
    const again = await footage.uploadFootage(p.id, mp4Stream(70 * 1024 * 1024), meta({ name: 'copy.mov' }), null);
    expect(again).toMatchObject({ duplicate: true, asset: { id: asset.id } });
    expect(await files(p.id)).toHaveLength(1);
    // same clip with other rights → 409, nothing silently dropped, no extra file
    await expect(footage.uploadFootage(p.id, mp4Stream(70 * 1024 * 1024), meta({ origin: 'licensed', rightsNote: 'Artlist #1' }), null)).rejects.toMatchObject({ status: 409 });
    expect(await files(p.id)).toHaveLength(1);
    // own footage never keeps a stale licence note
    expect((await footage.uploadFootage(p.id, mp4Stream(1000, 9), meta({ rightsNote: 'alt' }), null)).asset.rightsNote).toBe('');
    // Etappe 10: own footage needs no rights checkbox (implicit), the upload is stored with its confirmation time
    const implicit = await footage.uploadFootage(p.id, mp4Stream(1000, 7), { name: 'ohne-haken.mov', origin: 'own' }, null);
    expect(implicit.asset).toMatchObject({ origin: 'own', rightsNote: '' });
    expect(implicit.asset.rightsConfirmedAt).toBeTruthy();

    const { getMediaRecord } = await import('@/server/services/references');
    expect(await getMediaRecord(asset.id)).toMatchObject({ mime: 'video/mp4' });
  });

  it('rejects wrong types, missing rights and over-limit files without leaving files', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const p = await projects.createProject({ title: 'Limits', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH', productClaims: [] } });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(80).fill(0)]);
    await expect(footage.uploadFootage(p.id, bytesStream(png), meta(), null)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Dateityp/) });
    await expect(footage.uploadFootage(p.id, mp4Stream(1000), meta({ origin: 'licensed', rightsNote: 'Artlist #1', rightsConfirmed: false }), null)).rejects.toThrow(/Rechte/);
    await expect(footage.uploadFootage(p.id, mp4Stream(1000), { name: 'k.mov', origin: 'client', rightsNote: 'Vertrag vom 1.11.' }, null)).rejects.toThrow(/Rechte/);
    await expect(footage.uploadFootage(p.id, mp4Stream(1000), meta({ origin: 'client' }), null)).rejects.toThrow(/Quelle/);
    await expect(footage.uploadFootage(p.id, mp4Stream(0), meta(), null)).rejects.toMatchObject({ status: 400 });
    await expect(footage.uploadFootage('nope', mp4Stream(1000), meta(), null)).rejects.toMatchObject({ status: 404 });
    await expect(footage.uploadFootage('../../etc', mp4Stream(1000), meta(), null)).rejects.toMatchObject({ status: 404 });

    process.env.FOOTAGE_MAX_PROJECT_BYTES = String(3 * 1024 * 1024);
    try {
      await expect(footage.uploadFootage(p.id, mp4Stream(5 * 1024 * 1024), meta({ origin: 'client', rightsNote: 'Mail vom 12.11.' }), null)).rejects.toMatchObject({ status: 413 });
      await expect(footage.uploadFootage(p.id, mp4Stream(10), meta(), 5 * 1024 * 1024)).rejects.toMatchObject({ status: 413 }); // declared length checked up front
      const ok = await footage.uploadFootage(p.id, mp4Stream(2 * 1024 * 1024), meta({ origin: 'client', rightsNote: 'Mail vom 12.11.' }), null);
      expect(ok.asset).toMatchObject({ origin: 'client', rightsNote: 'Mail vom 12.11.' });
      expect((await footage.listFootage(p.id)).usedBytes).toBe(2 * 1024 * 1024);
    } finally {
      delete process.env.FOOTAGE_MAX_PROJECT_BYTES;
    }
    expect((await files(p.id)).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  it('deleting footage or its project deletes the files', async () => {
    const projects = await import('@/server/services/projects');
    const footage = await import('@/server/services/footage');
    const p = await projects.createProject({ title: 'Weg', kind: 'PERSONAL_CONTENT' });
    const a = (await footage.uploadFootage(p.id, mp4Stream(2048, 1), meta(), null)).asset;
    const b = (await footage.uploadFootage(p.id, mp4Stream(2048, 2), meta({ name: 'take2.mov' }), null)).asset;
    await footage.deleteFootage(a.id);
    expect(await files(p.id)).toEqual([path.basename(b.storagePath)]);
    await projects.deleteProject(p.id);
    expect(await files(p.id)).toEqual([]);
    await expect(footage.listFootage(p.id)).rejects.toMatchObject({ status: 404 });
  });
});
