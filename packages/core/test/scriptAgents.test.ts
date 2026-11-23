import { describe, expect, it } from 'vitest';
import {
  AD_DISCLOSURE, AI_DISCLOSURE, BriefInput, buildInstagramCopy, buildQaReport, buildStoryboard, lintCaption, mockScript, MockProvider,
  requiredDisclosures, runCinematicDirector, runContentQa, runInstagramCopywriter, type ConceptDraft, type CreativeContext, type UgcScript,
} from '../src';

const ctx = (over: Partial<CreativeContext> = {}): CreativeContext => ({
  brief: BriefInput.parse({ projectId: 'p1', topic: 'meine Strickmaschine', verifiedFacts: ['Die Maschine strickt 200 Nadeln breit'], lengthSeconds: 30 }),
  projectKind: 'PERSONAL_CONTENT', client: null, style: null, voice: null, growthHypothesis: null, strategy: null, profile: null, ...over,
});
const concept: ConceptDraft = { title: 'T', kind: 'K', hook: 'Das hier hat mich überrascht.', hookVariants: ['V1'], angle: 'a', structure: ['Hook', 'Kontext', 'Demo', 'CTA'], cta: 'Was meinst du?', rationale: 'r', styleNotes: '' };
const script = (over: Partial<UgcScript> = {}): UgcScript => ({ ...mockScript(ctx(), concept), ...over });
const voice = { versionId: 'v', version: 1, status: 'approved', rules: { traits: [], avoid: ['krass'], ownExamples: [] } };

describe('Content QA', () => {
  it('rule findings: open claims block, unspeakable timing, avoid-list hits, AI disclosure', () => {
    const s = script();
    s.claimsToVerify = ['Macht dich 10x schneller'];
    s.scenes[0]!.dialogue = 'Das ist krass ' + 'wort '.repeat(30);
    s.scenes[1]!.origin = 'generated';
    const { value: report } = buildQaReport({ summary: 'ok', findings: [] }, s, ctx({ voice }));
    const by = (c: string) => report.findings.filter((f) => f.category === c);
    expect(by('claim')[0]).toMatchObject({ severity: 'blocker', source: 'rule' });
    expect(by('timing')[0]).toMatchObject({ severity: 'warning', sceneIndex: 0 });
    expect(by('voice')[0]).toMatchObject({ quote: 'krass' });
    expect(by('disclosure')[0]!.suggestion).toContain(AI_DISCLOSURE);
    // voice avoid-list matches spoken text only, not stage directions
    const v = script();
    v.scenes[0]!.visual = 'krass bunte Kulisse';
    expect(buildQaReport({ summary: '', findings: [] }, v, ctx({ voice })).value.findings.some((f) => f.category === 'voice' && f.quote === 'krass')).toBe(false);
    // a zero-length scene with dialogue is flagged
    const z = script();
    z.scenes[0]!.endSecond = z.scenes[0]!.startSecond;
    expect(buildQaReport({ summary: '', findings: [] }, z, ctx()).value.findings.some((f) => f.category === 'timing' && f.sceneIndex === 0)).toBe(true);
    expect(report.blockers).toBe(1);
  });

  it('drops model quotes that are not in the script and invalid scene indexes', () => {
    const s = script();
    const { value: report, warnings } = buildQaReport({
      summary: 'x',
      findings: [
        { category: 'voice', severity: 'warning', sceneIndex: 0, quote: s.scenes[0]!.dialogue.slice(0, 20), issue: 'zu formell', suggestion: '' },
        { category: 'claim', severity: 'blocker', sceneIndex: 99, quote: 'Steht nirgends', issue: 'erfunden', suggestion: '' },
        { category: 'other', severity: 'info', sceneIndex: null, quote: `${s.selectedHook} ${s.cta}`, issue: 'über Feldgrenzen', suggestion: '' },
      ],
    }, s, ctx({ voice, style: { versionId: 's', version: 1, status: 'approved', rules: { name: 'S', visual: { palette: [], traits: [], avoid: [], typography: '', lighting: '', composition: '', textures: '' }, motion: { pacing: '', transitions: [] }, approvedReferenceIds: [], approvedObservationIds: [] } } }));
    const model = report.findings.filter((f) => f.source === 'model');
    expect(model[0]!.quote).toBe(s.scenes[0]!.dialogue.slice(0, 20));
    expect(model[1]).toMatchObject({ quote: null, sceneIndex: null });
    expect(model[2]!.quote).toBeNull();
    expect(warnings[0]).toMatch(/2 Zitat/);
  });

  it('mock runs rule checks only and says so', async () => {
    const r = await runContentQa(new MockProvider(), ctx(), script());
    expect(r.output.value.summary).toMatch(/MOCK/);
    expect(r.output.value.findings.every((f) => f.source === 'rule')).toBe(true);
  });
});

describe('Instagram copywriter', () => {
  const wire = { job: 'A', firstLine: 'Welche Maschine nutzt du?', body: ['Ein Absatz.'], ask: 'Schreib STRICK in die Kommentare.', searchTerms: ['Strickmaschine'], hashtags: ['strickmaschine', '#viral', 'fyp'], coverText: 'Neu eingefädelt', altText: 'Hände an der Maschine', claimsUsed: [] as string[] };
  const rules = (over = {}) => ({ required: [] as string[], allowed: ['Die Maschine strickt 200 Nadeln breit'], flagged: [] as string[], ...over });

  it('puts required labels first, removes generic hashtags, and the lint enforces the CURRENT labels', () => {
    const s = script();
    s.scenes[2]!.origin = 'hybrid';
    const required = requiredDisclosures({ projectKind: 'UGC_CLIENT', script: s });
    expect(required).toEqual([AD_DISCLOSURE, AI_DISCLOSURE]);
    const { value: copy, warnings } = buildInstagramCopy(wire, rules({ required }));
    expect(copy.caption.startsWith(`${AD_DISCLOSURE} · ${AI_DISCLOSURE} · Welche Maschine`)).toBe(true);
    expect(copy.hashtags).toEqual(['#strickmaschine']);
    expect(warnings[0]).toMatch(/#viral #fyp/);
    expect(copy.lint.filter((l) => l.level === 'fail')).toEqual([]);
    // project switched to client after writing → the stored personal caption lacks the ad label
    const personal = buildInstagramCopy(wire, rules()).value;
    expect(lintCaption(personal, rules({ required: [AD_DISCLOSURE] })).map((l) => l.message).join(' ')).toMatch(/Kennzeichnung fehlt/);
  });

  it('a storyboard with AI shots makes the AI label required', () => {
    expect(requiredDisclosures({ projectKind: 'PERSONAL_CONTENT', script: script(), storyboards: [{ shots: [{ origin: 'generated' }], aiAssetBriefs: [] }] })).toEqual([AI_DISCLOSURE]);
  });

  it('lint fails links, too many hashtags, flagged and unverified claims, label denials; warns on numbers', () => {
    const { value: copy } = buildInstagramCopy(
      { ...wire, body: ['Mehr auf https://example.com', 'Keine Werbung, ehrlich.'], altText: 'Macht dich 10x schneller', hashtags: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6'], claimsUsed: ['Spart 50 % Zeit', 'Die Maschine strickt 200 Nadeln breit'] },
      rules({ required: [AD_DISCLOSURE], flagged: ['Macht dich 10x schneller'] }),
    );
    const fails = copy.lint.filter((l) => l.level === 'fail').map((l) => l.message).join(' ');
    expect(fails).toMatch(/Link/);
    expect(fails).toMatch(/6 Hashtags/);
    expect(fails).toMatch(/10x schneller/); // flagged claim in the alt text
    expect(fails).toMatch(/ohne verifizierten Claim: Spart 50 % Zeit$/m);
    expect(fails).toMatch(/bestreitet die Werbekennzeichnung/);
    expect(copy.lint.find((l) => l.level === 'warn' && /Zahlen/.test(l.message))?.message).toMatch(/10/);
  });

  it('mock produces a lint-clean personal caption without labels', async () => {
    const r = await runInstagramCopywriter(new MockProvider(), ctx(), script(), rules());
    expect(r.output.value.disclosures).toEqual([]);
    expect(r.output.value.lint.filter((l) => l.level === 'fail')).toEqual([]);
  });
});

describe('Cinematic director', () => {
  it('keeps valid scenes, labels every AI brief and requires approval; client projects need client consent', () => {
    const s = script();
    s.scenes[3]!.origin = 'generated';
    s.scenes[0]!.shotType = 'product';
    const { value: storyboard, warnings } = buildStoryboard({
      logline: 'L',
      beats: [{ sceneIndex: 0, intent: 'i', camera: 'c', lighting: 'l', sound: 's', transition: 't' }, { sceneIndex: 7, intent: 'x', camera: '', lighting: '', sound: '', transition: '' }],
      shots: [
        { sceneIndex: 1, shot: 'Nebel', shotType: 'b_roll', framing: '9:16', movement: '', notes: '', origin: 'generated' },
        { sceneIndex: 2, shot: 'Garn', shotType: 'macro', framing: '9:16', movement: '', notes: '', origin: 'hybrid' },
        { sceneIndex: 3, shot: 'Ende', shotType: 'wide', framing: '9:16', movement: '', notes: '', origin: 'real' },
        { sceneIndex: 0, shot: 'Packshot', shotType: 'product', framing: '9:16', movement: '', notes: '', origin: 'generated' },
      ],
      aiAssetBriefs: [{ sceneIndex: 1, purpose: 'Atmosphäre', prompt: 'weicher Nebel im Stil von @someone' }, { sceneIndex: 0, purpose: 'Produkt', prompt: 'Packshot' }],
      production: { estimatedShootMinutes: 42.6, locations: ['Atelier', 'Atelier'], props: [] },
      warnings: [],
    }, s, ctx({ projectKind: 'UGC_CLIENT' }));
    expect(storyboard.beats).toHaveLength(1);
    expect(storyboard.aiAssetBriefs[0]).toMatchObject({ disclosureLabel: AI_DISCLOSURE, requiresApproval: true, clientApprovalRequired: true });
    expect(storyboard.production).toMatchObject({ estimatedShootMinutes: 43, locations: ['Atelier'] });
    expect(warnings.join(' ')).toMatch(/Kundenprojekt/);
    expect(storyboard.shots.find((x) => x.sceneIndex === 3)!.origin).toBe('generated'); // never more real than its scene
    expect(storyboard.shots.find((x) => x.sceneIndex === 0)!.origin).toBe('real'); // product shots stay real
    expect(storyboard.aiAssetBriefs).toHaveLength(1); // brief for the product scene removed
    const w = warnings.join(' ');
    expect(w).toMatch(/Produkt-Einstellung/);
    expect(w).toMatch(/im Stil von/);
    expect(w).toMatch(/2 KI-\/Hybrid-Einstellung/);
  });

  it('mock derives beats and shots from the script scenes', async () => {
    const s = script();
    const r = await runCinematicDirector(new MockProvider(), ctx(), s);
    expect(r.output.value.beats).toHaveLength(s.scenes.length);
    expect(r.output.value.aiAssetBriefs).toEqual([]);
  });
});
