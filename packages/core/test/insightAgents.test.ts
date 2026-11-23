import { describe, expect, it } from 'vitest';
import {
  buildGrowthReport, buildResearchReport, growthFacts, growthLimitations, MockProvider, ResearchRequest, runGrowthAnalyst, runResearchAnalyst,
  unverifiedNumbers, type GrowthPost,
} from '../src';

const post = (id: string, window: '24h' | '7d' | '30d', reach: number, saves: number, shares: number, observedAt = '2026-11-10T10:00:00Z'): GrowthPost => ({
  publicationId: id, title: `Post ${id}`, hook: `Hook ${id}`, window, observedAt, format: 'reel', concept: null, styleVersion: null, voiceVersion: null,
  metrics: { reach, views: reach * 2, likes: null, comments: null, saves, shares, follows: null },
});

describe('Growth Analyst', () => {
  const facts = growthFacts([
    post('a', '7d', 1000, 20, 9), post('a', '7d', 1200, 30, 10, '2026-11-12T10:00:00Z'), post('b', '7d', 800, 8, 2), post('a', '24h', 400, 5, 1), post('c', '7d', 0, 0, 0),
  ]);

  it('keeps the latest snapshot per publication and window, skips reach 0', () => {
    expect(facts.rows).toHaveLength(3);
    expect(facts.rows.find((r) => r.publicationId === 'a' && r.window === '7d')!.reach).toBe(1200);
    expect(facts.windows).toEqual([{ window: '24h', posts: 1 }, { window: '7d', posts: 2 }]);
    expect(growthLimitations(facts).join(' ')).toMatch(/7d-Fenster: nur 2/);
  });

  it('verifies numbers against the measured table (decimal comma, thousands dot)', () => {
    const allowed = new Set(['3.33', '1200', '2']);
    expect(unverifiedNumbers('3,33 % bei 1.200 Reichweite in 2 Posts', allowed)).toEqual([]);
    expect(unverifiedNumbers('Plus 47 % Wachstum', allowed)).toEqual(['47']);
  });

  it('drops observations across windows, with foreign posts or invented numbers; flags loose numbers', () => {
    const { value, warnings } = buildGrowthReport({
      summary: 'Wachstum um 47 %', hypothesis: 'h',
      observations: [
        { statement: 'Post a hatte 3,33 % Saves+Shares pro Reichweite.', window: '7d', publicationIds: ['a'] },
        { statement: 'Post a schlägt Post a im 24h-Fenster.', window: '7d', publicationIds: ['a', 'ghost'] },
        { statement: 'Post b ist 5x besser als der Durchschnitt mit 12 %.', window: '7d', publicationIds: ['b'] },
        { statement: 'Vergleich', window: '30d', publicationIds: ['a'] },
      ],
      experiments: [{ change: 'Anderer Einstieg', keepConstant: 'Format', metric: 'savesSharesPerReachPct', window: '7d', minPosts: 0, successCriterion: 'höher' }],
      limitations: ['eigene Grenze'],
    }, facts);
    expect(value.observations.map((o) => o.publicationIds)).toEqual([['a']]);
    expect(warnings[0]).toMatch(/^3 Beobachtung/);
    expect(value.unverifiedNumbers).toEqual(['47']);
    expect(value.experiments[0]!.minPosts).toBe(2);
    expect(value.limitations[0]).toMatch(/Korrelation/);
    expect(value.limitations).toContain('eigene Grenze');
  });

  it('numbers must come from the same window; small counts ok, but not as % or multiplier; relative quantities flagged', () => {
    const { value, warnings } = buildGrowthReport({
      summary: 'Carousels bringen 100 % mehr Saves', hypothesis: 'Reels verdoppeln die Saves bei 3 Beiträgen',
      observations: [
        { statement: 'Post a hatte im 7d-Fenster 1,5 % Saves+Shares pro Reichweite.', window: '7d', publicationIds: ['a'] }, // 1,5 % is the 24h value
        { statement: 'Post a im 24h-Fenster: 1,5 %, 3 Beiträge im Vergleich.', window: '24h', publicationIds: ['a'] },
      ],
      experiments: [{ change: 'Hook wie Top-Creator (Branchenschnitt 9 % Saves)', keepConstant: 'Format', metric: 'savesSharesPerReachPct', window: '7d', minPosts: 3, successCriterion: '2x höher' }],
      limitations: [],
    }, facts);
    expect(value.observations.map((o) => o.window)).toEqual(['24h']);
    expect(value.unverifiedNumbers).toEqual(['100', '9', '2']);
    expect(warnings.join(' ')).toMatch(/Relative Mengenangaben.*verdoppeln/);
  });

  it('digits in post titles and hooks are data, not claims', async () => {
    const titled = growthFacts([{ ...post('t', '7d', 1000, 40, 13), title: '3 Fehler 2026', hook: 'Teil 11' }]);
    const r = await runGrowthAnalyst(new MockProvider(), titled);
    expect(r.output.value.observations).toHaveLength(1);
    expect(r.output.warnings).toEqual([]);
    expect(unverifiedNumbers('2026', new Set())).toEqual(['2026']);
  });

  it('mock cites only measured values and survives its own verification', async () => {
    const r = await runGrowthAnalyst(new MockProvider(), facts);
    expect(r.output.value.observations).toHaveLength(2);
    expect(r.output.warnings).toEqual([]);
    expect(r.output.value.summary).toMatch(/MOCK/);
  });
});

describe('Research Analyst', () => {
  const req = ResearchRequest.parse({
    projectId: 'p', topic: 'Merinowolle',
    sources: [
      { title: 'Hersteller', url: 'https://example.com/merino', text: 'Merinowolle ist feiner als normale Schurwolle. Sie kratzt deshalb weniger auf der Haut.' },
      { title: 'Notizen', text: 'Meine Kundin wäscht die Pullover bei 30 Grad im Wollprogramm ohne Probleme.' },
    ],
  });

  it('validates sources: own text required, URL is only a http(s) label', () => {
    expect(() => ResearchRequest.parse({ ...req, sources: [] })).toThrow(/Mindestens eine/);
    expect(() => ResearchRequest.parse({ ...req, sources: [{ title: 'x', url: 'javascript:alert(1)', text: 'x'.repeat(50) }] })).toThrow(/http/);
  });

  it('keeps only facts with a verbatim quote from the cited source; unbacked audience claims become assumptions', () => {
    const { value, warnings } = buildResearchReport({
      facts: [
        { statement: 'Merino ist feiner als Schurwolle', sourceIndex: 0, quote: 'Merinowolle ist feiner als normale Schurwolle' },
        { statement: 'Wäsche bei 30 Grad', sourceIndex: 0, quote: 'bei 30 Grad im Wollprogramm' }, // wrong source
        { statement: 'Hält 10 Jahre', sourceIndex: 1, quote: 'hält mindestens zehn Jahre' }, // invented
      ],
      audienceInsights: [
        { statement: 'Empfindliche Haut', basis: 'source', sourceIndex: 0, quote: 'Sie kratzt deshalb weniger' },
        { statement: 'Mag Nachhaltigkeit', basis: 'source', sourceIndex: 1, quote: 'liebt Nachhaltigkeit' },
      ],
      angles: ['a', 'a'], openQuestions: [], uncertainties: [],
    }, req.sources);
    expect(value.facts.map((f) => f.statement)).toEqual(['Merino ist feiner als Schurwolle']);
    expect(value.audienceInsights.map((a) => a.basis)).toEqual(['source', 'assumption']);
    expect(value.angles).toEqual(['a']);
    expect(warnings).toHaveLength(2);
  });

  it('a fact needs a quote of at least 4 words and may not add numbers; the 15-fact cap is reported separately', () => {
    const base = { audienceInsights: [], angles: [], openQuestions: [], uncertainties: [] };
    const q = 'Merinowolle ist feiner als normale Schurwolle';
    const { value, warnings } = buildResearchReport({
      ...base,
      facts: [
        { statement: 'Merino ist 3x feiner als Schurwolle', sourceIndex: 0, quote: q }, // adds a number
        { statement: 'Merino kratzt nie', sourceIndex: 0, quote: 'kratzt deshalb' }, // too short to back anything
        { statement: 'Wäsche bei 30 Grad', sourceIndex: 1, quote: 'wäscht die Pullover bei 30 Grad' },
      ],
    }, req.sources);
    expect(value.facts.map((f) => f.statement)).toEqual(['Wäsche bei 30 Grad']);
    expect(warnings).toEqual([expect.stringMatching(/^2 Fakt/)]);
    const many = buildResearchReport({ ...base, facts: Array.from({ length: 17 }, () => ({ statement: 'Merino ist fein', sourceIndex: 0, quote: q })) }, req.sources);
    expect(many.value.facts).toHaveLength(15);
    expect(many.warnings).toEqual([expect.stringMatching(/^2 weitere belegte/)]);
  });

  it('mock quotes the first sentence of each source verbatim', async () => {
    const r = await runResearchAnalyst(new MockProvider(), req);
    expect(r.output.value.facts).toHaveLength(2);
    expect(r.output.warnings).toEqual([]);
  });
});
