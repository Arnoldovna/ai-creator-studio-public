import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_INPUT_KIND, EVAL_USE_CASES, ROUTING_POLICIES, USE_CASES } from '@studio/core';
import { passFit, seedApprovedStrategy } from './helpers/strategy';

/**
 * Router contract over ALL use cases (Etappe 5): every policy has a wired agent, every agent is reachable
 * through the Model Lab with the mock provider, the run log names the policy's agent and use case,
 * and a comparison never changes studio data.
 */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MODELS = ['openai/gpt-6-luna', 'meta/muse-spark-1.3'];

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'studio-contract-'));
  Object.assign(process.env, { STUDIO_DATA_DIR: dir, AI_PROVIDER: 'mock' });
  await seedApprovedStrategy();
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('Router contract: all use cases', () => {
  it('every routing policy names an agent and is available in the Model Lab; cost sizing counts the real input', async () => {
    for (const u of USE_CASES) expect(ROUTING_POLICIES[u].agent, u).toBeTruthy();
    expect([...EVAL_USE_CASES].sort()).toEqual([...USE_CASES].sort());
    const { requestSize } = await import('@/server/services/agentRuns');
    // Without inputChars the serialized input sizes quote and run alike (not the policy's typical size)
    expect(requestSize({ input: 'x'.repeat(2998) }).inputTokens).toBe(1000);
    expect(requestSize({ input: {}, inputChars: 300 }).inputTokens).toBe(100);
    // Too little own text: a 400 before anything is called or stored, like the normal button
    const evals = await import('@/server/services/eval');
    await expect(evals.quoteEval({ useCase: 'voice_analysis', input: { kind: 'voice' }, modelIds: MODELS })).rejects.toMatchObject({ status: 400 });
  });

  it('each use case runs through the Model Lab with its own agent and leaves studio data unchanged', async () => {
    const refs = await import('@/server/services/references');
    const style = await import('@/server/services/style');
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const analytics = await import('@/server/services/analytics');
    const insights = await import('@/server/services/insights');
    const evals = await import('@/server/services/eval');
    const { read } = await import('@/server/store');

    // Minimal studio state for every input kind
    const { reference } = await refs.createReference(new File([PNG], 'poster.png', { type: 'image/png' }), null);
    await refs.updateReference(reference.id, { likes: ['warme Schatten'] });
    const { observations } = await refs.analyzeReference(reference.id);
    await refs.reviewObservation(observations.find((o) => o.statement.startsWith('Von dir markiert'))!.id, { decision: 'approved', feedback: '' });
    await style.saveForms({ voice: { traits: 'direkt', avoid: '', example: 'Ich probier das einfach mal aus und zeig dir, was passiert, wenn das Garn nicht so will wie ich.' } });
    const own = await projects.createProject({ title: 'Eigenes', kind: 'PERSONAL_CONTENT' });
    const brief = { projectId: own.id, topic: 'Strickmaschine', pillarId: 'werkstatt' };
    const { concepts } = await content.generateConcepts(brief);
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    await content.setScriptStatus(script.id, 'approved', { claimsReviewed: true });
    // Etappe 18: a carousel from the concept (its source and settings are the Model Lab input)
    await (await import('@/server/services/carousels')).createCarousel(own.id, { source: { kind: 'concept', id: concepts[0]!.id } });
    await (await import('@/server/services/stories')).createStories(own.id, { source: { kind: 'concept', id: concepts[0]!.id } });
    const pub = await analytics.createPublication({ projectId: own.id, title: 'Reel 1', publishedAt: '2026-11-01' });
    await analytics.addSnapshot({ publicationId: pub.id, window: '7d', metrics: { reach: 1000, views: 2000, saves: 30, shares: 5 } });
    const chat = await import('@/server/services/chat');
    const thread = await chat.createThread({ scope: 'general' });
    await chat.sendMessage(thread.id, { text: 'mach den Akzent wärmer' });
    const research = await insights.runResearch({ projectId: own.id, topic: 'Lochkarten', audience: 'Strick-Anfängerinnen', sources: [{ title: 'Handbuch', text: 'Die Strickmaschine arbeitet mit Lochkarten. Muster werden so wiederholbar.' }] });

    const inputs: Record<(typeof USE_CASES)[number], unknown> = {
      reference_image_analysis: { kind: 'reference', referenceId: reference.id },
      reference_video_analysis: null, // needs a real video + FFmpeg; covered by the e2e upload flow
      style_synthesis: { kind: 'style' },
      voice_analysis: { kind: 'voice' },
      content_research: { kind: 'research', reportId: research.id },
      content_strategy: { kind: 'brief', brief },
      ugc_scriptwriting: { kind: 'concept', conceptId: concepts[0]!.id },
      cinematic_direction: { kind: 'script', scriptId: script.id },
      instagram_copywriting: { kind: 'script', scriptId: script.id },
      growth_analysis: { kind: 'growth' },
      content_quality_assurance: { kind: 'script', scriptId: script.id },
      design_system_synthesis: { kind: 'design' },
      studio_chat: { kind: 'chat' },
      edit_direction: null, // needs footage with a transcript and a stored proposal; covered by test/editDirection.test.ts
      carousel_writing: { kind: 'carousel' },
      story_writing: { kind: 'ig_story' },
      week_planning: { kind: 'week' },
    };

    const snapshot = () => read((db) => ({
      analyses: db.analyses.length, observations: db.observations.length, suggestions: db.directorSuggestions.length, styleVersions: db.styleBibles.length,
      voiceVersions: db.voiceGuides.length, concepts: db.concepts.length, scripts: db.scripts.length, scriptOutputs: db.scriptOutputs.length,
      growth: db.growthReports.length, research: db.researchReports.length, forms: JSON.stringify(db.styleForms),
    }));
    const before = await snapshot();

    const runs: Record<string, Awaited<ReturnType<typeof evals.runEval>>> = {};
    for (const useCase of USE_CASES) {
      const input = inputs[useCase];
      if (!input) continue;
      expect((input as { kind: string }).kind, useCase).toBe(EVAL_INPUT_KIND[useCase]);
      const run = (runs[useCase] = await evals.runEval({ useCase, input, modelIds: MODELS }));
      expect(run.mock, useCase).toBe(true);
      expect(run.results.map((r) => r.error), useCase).toEqual([null, null]);
      const logged = await read((db) => run.results.map((r) => db.agentRuns.find((a) => a.id === r.agentRunId)!));
      for (const a of logged) expect(a, useCase).toMatchObject({ agent: ROUTING_POLICIES[useCase].agent, useCase, status: 'succeeded', routing: { mode: 'mock' } });
    }
    expect(await snapshot()).toEqual(before);
    // Research re-runs with the stored audience (same task as the normal flow)
    expect(JSON.stringify(runs.content_research!.results[0]!.output)).toContain('Strick-Anfängerinnen');

    // Deleting the project deletes the comparisons made on its data (growth via its publications)
    await projects.deleteProject(own.id);
    const left = await read((db) => db.evalRuns.map((r) => r.useCase));
    expect(left.sort()).toEqual(['design_system_synthesis', 'reference_image_analysis', 'studio_chat', 'style_synthesis', 'voice_analysis', 'week_planning']); // the week is not one project's data
  });

  it('client data is never compared (script, research)', async () => {
    const projects = await import('@/server/services/projects');
    const content = await import('@/server/services/content');
    const insights = await import('@/server/services/insights');
    const evals = await import('@/server/services/eval');
    const client = await projects.createProject({ title: 'Kunde', kind: 'UGC_CLIENT', client: { clientName: 'Garn GmbH', productClaims: [] } });
    const { concepts } = await content.generateConcepts({ pillarId: 'werkstatt', projectId: client.id, topic: 'Garn' });
    await passFit(concepts[0]!.id);
    const script = await content.selectConceptAndWrite(concepts[0]!.id);
    const chat = await import('@/server/services/chat');
    const thread = await chat.createThread({ scope: 'general' });
    await chat.sendMessage(thread.id, { text: 'mach den Akzent wärmer' });
    const research = await insights.runResearch({ projectId: client.id, topic: 'Garn', sources: [{ title: 'Produktblatt', text: 'Das Garn ist aus Merinowolle. Es ist bei 30 Grad waschbar.' }] });
    for (const [useCase, input] of [
      ['content_quality_assurance', { kind: 'script', scriptId: script.id }],
      ['cinematic_direction', { kind: 'script', scriptId: script.id }],
      ['content_research', { kind: 'research', reportId: research.id }],
    ] as const) {
      await expect(evals.quoteEval({ useCase, input, modelIds: MODELS }), useCase).rejects.toMatchObject({ status: 409 });
    }
    // The overview offers only inputs the lab accepts
    const overview = await evals.getEvalOverview();
    expect(overview.scripts.map((x) => x.id)).not.toContain(script.id);
    expect(overview.researchReports.map((x) => x.id)).not.toContain(research.id);
    // Copy keeps its own gate: only for approved scripts
    await expect(evals.quoteEval({ useCase: 'instagram_copywriting', input: { kind: 'script', scriptId: script.id }, modelIds: MODELS })).rejects.toMatchObject({ status: 409 });
  });
});
