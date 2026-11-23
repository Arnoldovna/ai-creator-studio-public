import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-directors-'));
  process.env.STUDIO_DATA_DIR = dir;
  process.env.AI_PROVIDER = 'mock';
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('Style & Voice Director (mock provider)', () => {
  it('suggests from approved observations only, never creates a version, links lineage on request', async () => {
    const refs = await import('@/server/services/references');
    const style = await import('@/server/services/style');
    const { read } = await import('@/server/store');

    await expect(style.synthesizeStyle()).rejects.toMatchObject({ status: 400 });

    const { reference } = await refs.createReference(new File([PNG], 'poster.png', { type: 'image/png' }), JSON.stringify(['#E0A040']));
    await refs.updateReference(reference.id, { likes: ['warme Schatten', 'Wolle'], dislikes: ['Neon'] });
    const { observations } = await refs.analyzeReference(reference.id);
    const liked = observations.filter((o) => o.statement.startsWith('Von dir markiert'));
    const placeholder = observations.find((o) => o.statement.startsWith('[MOCK]'))!;
    await refs.reviewObservation(liked[0]!.id, { decision: 'approved', feedback: '' });
    await refs.reviewObservation(placeholder.id, { decision: 'rejected', feedback: '' });
    // liked[1] stays pending

    const s = await style.synthesizeStyle();
    expect(s.kind).toBe('style');
    expect(s.mock).toBe(true);
    if (s.kind !== 'style') throw new Error('kind');
    expect(s.observationIds).toEqual([liked[0]!.id]);
    expect(s.output.evidence.flatMap((e) => e.observationIds).every((id) => s.observationIds.includes(id))).toBe(true);
    const st = await style.getStyleState();
    expect(st.versions).toHaveLength(0); // a suggestion is not a version
    expect(st.suggestions.style?.id).toBe(s.id);

    const run = await read((db) => db.agentRuns.find((r) => r.id === s.agentRunId)!);
    expect(run).toMatchObject({ agent: 'style_director', useCase: 'style_synthesis', status: 'succeeded' });

    const v = await style.createStyleVersion({ name: 'Quiet Craft', traits: s.output.traits.join('\n'), suggestionId: s.id });
    // Etappe 10: saving makes the version active at once
    expect(v).toMatchObject({ status: 'approved', suggestionId: s.id, warnings: [] });
    await expect(style.createStyleVersion({ name: 'x', suggestionId: 'unknown' })).rejects.toMatchObject({ status: 404 });
    await expect(style.createVoiceVersion({ traits: 'x', suggestionId: s.id })).rejects.toMatchObject({ status: 404 }); // wrong kind

    // Once an underlying observation is rejected, the suggestion is outdated: still usable, with a warning only.
    await refs.reviewObservation(liked[0]!.id, { decision: 'rejected', feedback: '' });
    expect((await style.getStyleState()).suggestions.style?.outdated).toBe(true);
    const outdated = await style.createStyleVersion({ name: 'x', suggestionId: s.id });
    expect(outdated).toMatchObject({ status: 'approved', suggestionId: s.id, warnings: [style.OUTDATED_SUGGESTION_WARNING] });
    // the rejected observation does not flow into the rules (only confirmed ones are her selection)
    expect(outdated.rules.approvedObservationIds).not.toContain(liked[0]!.id);
    expect((await style.getStyleState()).versions.find((x) => x.id === v.id)?.status).toBe('archived');

    // A form sent with the request is used and saved together with the suggestion.
    await refs.reviewObservation(liked[1]!.id, { decision: 'approved', feedback: '' });
    const s2 = await style.synthesizeStyle({ style: { name: 'Neu', lighting: 'Nordlicht' } });
    if (s2.kind !== 'style') throw new Error('kind');
    expect(s2.output.name).toBe('Neu');
    expect((await style.getStyleState()).form.lighting).toBe('Nordlicht');
  });

  it('analyses own texts plus stored examples and treats form entries as the user’s rules', async () => {
    const style = await import('@/server/services/style');
    const { read } = await import('@/server/store');
    const runsBefore = await read((db) => db.agentRuns.length);
    await expect(style.analyzeVoice({ samples: ['kurz'] })).rejects.toMatchObject({ status: 400 });
    expect(await read((db) => db.agentRuns.length)).toBe(runsBefore); // input error: nothing called, nothing logged
    await expect(style.analyzeVoice({ samples: ['x'.repeat(4001)] })).rejects.toThrow(/max. 4000 Zeichen/);
    await expect(style.analyzeVoice({ samples: 'kein Array' })).rejects.toThrow();

    await style.saveForms({ voice: { traits: 'direkt', avoid: 'Clickbait', example: 'Ich probier das einfach mal aus und zeig dir, was passiert.' } });
    const s = await style.analyzeVoice({ samples: ['Heute: neues Garn. Wird das was? Keine Ahnung.', ''] });
    if (s.kind !== 'voice') throw new Error('kind');
    expect(s.sampleCount).toBe(2); // new sample + stored example, empty paragraph ignored
    expect(s.output.traits.find((t) => t.trait === 'direkt')?.source).toBe('user');
    expect(s.output.avoid.map((a) => a.pattern)).toContain('Clickbait');
    const v = await style.createVoiceVersion({ traits: 'direkt', avoid: 'Clickbait', example: '', suggestionId: s.id });
    expect(v.suggestionId).toBe(s.id);
  });
});
