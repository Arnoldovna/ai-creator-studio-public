import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { passFit } from './helpers/strategy';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-script-agents-'));
  process.env.STUDIO_DATA_DIR = dir;
  process.env.AI_PROVIDER = 'mock';
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('QA, Instagram copy and cinematic direction on a script (mock provider)', () => {
  it('runs on script versions, keeps human gates and lineage, cascades with the project', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const style = await import('@/server/services/style');
    const agents = await import('@/server/services/scriptAgents');
    const { read, write } = await import('@/server/store');

    const s1 = await style.createStyleVersion({ name: 'Stil 1' });
    await style.approveVersion('style', s1.id);
    const project = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH', productClaims: ['Das Garn ist aus Merinowolle'] } });
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: project.id, topic: 'Merinogarn', lengthSeconds: 15 });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const s2 = await style.createStyleVersion({ name: 'Stil 2' });
    await style.approveVersion('style', s2.id);

    // QA: advisory, confidential client routing, uses the style version the script was written with
    const qa = await agents.runScriptAgent('qa', script.id);
    if (qa.kind !== 'qa') throw new Error('kind');
    expect(qa.output.findings.some((f) => f.category === 'disclosure' && f.suggestion.includes('Anzeige'))).toBe(true);
    const run = await read((db) => db.agentRuns.find((r) => r.id === qa.agentRunId)!);
    expect(run).toMatchObject({ agent: 'content_qa', useCase: 'content_quality_assurance', routing: { confidential: true }, styleVersionId: s1.id });
    await expect(agents.approveScriptOutput(qa.id, {})).rejects.toMatchObject({ status: 409 });
    await expect(agents.runScriptAgent('nope', script.id)).rejects.toThrow();
    const qa2 = await agents.runScriptAgent('qa', script.id);
    expect(await read((db) => db.scriptOutputs.filter((o) => o.kind === 'qa').map((o) => o.id))).toEqual([qa2.id]); // older draft replaced

    // Copy only for an approved script; confirmation required; labels first
    await expect(agents.runScriptAgent('copy', script.id)).rejects.toMatchObject({ status: 409 });
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    const copy = await agents.runScriptAgent('copy', script.id);
    if (copy.kind !== 'copy') throw new Error('kind');
    expect(copy.output.caption.startsWith('Anzeige · ')).toBe(true);
    await expect(agents.approveScriptOutput(copy.id, {})).rejects.toThrow(/Bestätigung fehlt/);
    expect((await agents.approveScriptOutput(copy.id, { confirmed: true })).status).toBe('approved');

    // Storyboard: real footage only → no extra confirmation
    const board = await agents.runScriptAgent('storyboard', script.id);
    expect((await agents.approveScriptOutput(board.id, {})).status).toBe('approved');

    // A storyboard that plans AI media needs confirmation + documented client consent, and demotes a caption without the AI label
    await write((db) => {
      const b = db.scriptOutputs.find((o) => o.id === board.id)!;
      if (b.kind !== 'storyboard') throw new Error('kind');
      b.status = 'draft';
      b.output.shots[1]!.origin = 'generated';
    });
    await expect(agents.approveScriptOutput(board.id, {})).rejects.toThrow(/Bestätigung fehlt/);
    await expect(agents.approveScriptOutput(board.id, { confirmed: true })).rejects.toThrow(/Zustimmung der Kundin/);
    const approvedBoard = await agents.approveScriptOutput(board.id, { confirmed: true, clientConsentNote: 'Mail vom 12.11.' });
    expect(approvedBoard.clientConsentNote).toBe('Mail vom 12.11.');
    const view = (await content.getContent(project.id)).scriptOutputs.find((o) => o.id === copy.id)!;
    expect(view.status).toBe('draft');
    expect(view.gate.blockers.join(' ')).toMatch(/Kennzeichnung fehlt/);

    // Rejecting the script demotes its approved outputs; rejected scripts get nothing new
    await content.setScriptStatus(script.id, 'rejected');
    expect(await read((db) => db.scriptOutputs.filter((o) => o.status === 'approved').length)).toBe(0);
    await expect(agents.runScriptAgent('qa', script.id)).rejects.toMatchObject({ status: 409 });

    await projects.deleteProject(project.id);
    expect(await read((db) => db.scriptOutputs.length)).toBe(0);
  });
});
