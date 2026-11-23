import { describe, expect, it } from 'vitest';
import {
  emptyStyleForm, emptyVoiceForm, joinList, MockProvider, mockStyleSuggestion, normalizeStyleSuggestion, normalizeVoiceSuggestion, runStyleDirector,
  runVoiceDirector, splitList, STYLE_FORM_LIMITS, StyleFormInput, styleSuggestionToForm, voiceSuggestionToForm, type StyleSuggestion,
} from '../src';

const obs = [
  { id: 'o1', referenceName: 'a.png', dimension: 'composition', kind: 'observed', statement: 'viel Negativraum links', confidence: 0.8 },
  { id: 'o2', referenceName: 'b.png', dimension: 'lighting', kind: 'observed', statement: 'weiches Seitenlicht', confidence: 0.7 },
  { id: 'o3', referenceName: 'b.png', dimension: 'aesthetic', kind: 'interpreted', statement: 'ruhig, handgemacht', confidence: 0.6 },
  { id: 'o4', referenceName: 'b.png', dimension: 'color', kind: 'observed', statement: 'Ocker und Schwarz', confidence: 0.9 },
];
const wire = (over: Partial<StyleSuggestion> = {}): StyleSuggestion => ({
  name: 'Quiet Craft', traits: ['ruhig'], avoid: [], typography: '', lighting: '', composition: '', textures: '', motion: '', transitions: [],
  evidence: [], conflicts: [], uncertainties: [], ...over,
});

describe('Style Director', () => {
  it('drops evidence that points to unknown (hallucinated) observations', () => {
    const { suggestion, warnings } = normalizeStyleSuggestion(
      wire({ evidence: [{ field: 'lighting', observationIds: ['o2', 'ghost'], note: 'x' }, { field: 'traits', observationIds: ['nope'], note: 'y' }] }),
      ['o1', 'o2'],
    );
    expect(suggestion.evidence).toEqual([{ field: 'lighting', observationIds: ['o2'], note: 'x' }]);
    expect(warnings.join(' ')).toMatch(/2 Evidenz-Verweis/);
  });

  it('joinList is the inverse of splitList and respects the form limit', () => {
    expect(splitList(joinList(['warm, aber gedämpft', 'Korn; analog']))).toEqual(['warm / aber gedämpft', 'Korn / analog']);
    expect(joinList(['aaaa', 'bbbb', 'cccc'], 9)).toBe('aaaa\nbbbb');
  });

  it('applying a suggestion adds to the user entries and never empties or overflows them', () => {
    const current = { ...emptyStyleForm(), name: 'Mein Stil', traits: 'grafisch', typography: 'Editorial, viel Weißraum', palette: '#111111' };
    const many = Array.from({ length: 20 }, (_, i) => `${i} ${'x'.repeat(150)}`);
    const { suggestion } = normalizeStyleSuggestion(wire({ traits: ['grafisch', 'warm, aber gedämpft', ...many], typography: '', lighting: 'Seitenlicht' }), []);
    const form = styleSuggestionToForm(suggestion, current);
    expect(form.name).toBe('Mein Stil');
    expect(form.typography).toBe('Editorial, viel Weißraum'); // empty suggestion field keeps the user's text
    expect(form.lighting).toBe('Seitenlicht');
    expect(splitList(form.traits, 40).slice(0, 2)).toEqual(['grafisch', 'warm / aber gedämpft']);
    expect(form.traits.length).toBeLessThanOrEqual(STYLE_FORM_LIMITS.traits);
    expect(() => StyleFormInput.parse(form)).not.toThrow();
    expect(form.palette).toBe('#111111'); // palette is never an LLM decision
  });

  it('mock fills empty text fields from matching observations and cites only given IDs', async () => {
    const input = { form: { ...emptyStyleForm(), lighting: 'Fensterlicht', traits: 'grafisch' }, approvedObservations: obs, likes: ['Wolle'], dislikes: ['Neon'] };
    const s = mockStyleSuggestion(input);
    expect(s.lighting).toBe('Fensterlicht');
    expect(s.composition).toBe('viel Negativraum links');
    expect(s.traits).toEqual(['grafisch']); // likes/observations are added by composeStyleBible, not duplicated here
    expect(s.evidence.flatMap((e) => e.observationIds).sort()).toEqual(['o1', 'o2']);
    const res = await runStyleDirector(new MockProvider(), input);
    expect(res.output.suggestion.uncertainties[0]).toMatch(/MOCK/);
    expect(res.promptVersion).toMatch(/^style-director@/);
  });
});

describe('Voice Director', () => {
  const samples = ['Ich hab heute die Maschine neu eingefädelt. Klingt banal? War es nicht.', 'Du kennst das bestimmt: ein Faden, drei Knoten.'];

  it('keeps only verbatim quotes from the user texts', () => {
    const { suggestion, warnings } = normalizeVoiceSuggestion(
      {
        traits: [
          { trait: 'kurze Sätze', evidenceQuote: 'Klingt  banal?' },
          { trait: 'Superlative', evidenceQuote: 'Das beste Garn der Welt!' },
          { trait: 'neugierig', evidenceQuote: '' },
        ],
        avoid: [{ pattern: 'Sales-Phrasen', reason: 'passt nicht' }],
        signaturePhrases: ['Du kennst das bestimmt', 'Game changer', 'War es nicht. Du kennst das'], // last one spans two samples
        sentenceStyle: 'kurz', conflicts: [], uncertainties: [],
      },
      samples,
      ['neugierig'],
    );
    expect(suggestion.traits).toEqual([
      { trait: 'kurze Sätze', evidenceQuote: 'Klingt  banal?', source: 'samples' },
      { trait: 'Superlative', evidenceQuote: null, source: 'samples' },
      { trait: 'neugierig', evidenceQuote: null, source: 'user' },
    ]);
    expect(suggestion.signaturePhrases).toEqual(['Du kennst das bestimmt']);
    expect(warnings).toHaveLength(2); // 1 unbacked trait (user trait exempt) + invented phrases
    expect(warnings[1]).toMatch(/^2 /);
    expect(voiceSuggestionToForm(suggestion, { ...emptyVoiceForm(), traits: 'humorvoll, neugierig', example: 'mein Text' })).toEqual({
      traits: 'humorvoll\nneugierig\nkurze Sätze\nSuperlative', avoid: 'Sales-Phrasen', example: 'mein Text',
    });
  });

  it('mock measures text statistics and rejects too little text', async () => {
    const res = await runVoiceDirector(new MockProvider(), { samples, userTraits: ['direkt'], userAvoid: ['Clickbait'] });
    const s = res.output.suggestion;
    expect(s.traits.find((t) => t.trait === 'direkt')?.source).toBe('user');
    expect(s.traits.find((t) => t.trait === 'stellt Fragen')?.evidenceQuote).toBe('Klingt banal?');
    expect(s.signaturePhrases.every((p) => samples.join(' ').includes(p))).toBe(true);
    expect(s.avoid).toEqual([{ pattern: 'Clickbait', reason: 'Von dir festgelegt.' }]);
    expect(res.output.warnings).toEqual([]);
    await expect(runVoiceDirector(new MockProvider(), { samples: ['zu kurz'], userTraits: [], userAvoid: [] })).rejects.toMatchObject({ status: 400 });
  });
});
