import { describe, expect, it } from 'vitest';
import {
  conceptLintParts, copyLintParts, editPlanLintParts, lintBoundaries, scriptLintParts, sentenceFingerprint, storyboardLintParts,
  type LintFinding, type NoGoCategory, type SensitiveTerm,
} from '../src';
import { FIXTURE_SENSITIVE_TERMS } from './fixtures/strategy';
import { LINT_NEGATIVE_CORPUS } from './fixtures/lint-negative';

const lint = (text: string, opts: { kind?: 'PERSONAL_CONTENT' | 'UGC_CLIENT'; terms?: SensitiveTerm[]; field?: string } = {}) =>
  lintBoundaries([{ field: opts.field ?? 'hook', text }], { projectKind: opts.kind ?? 'PERSONAL_CONTENT', terms: opts.terms ?? [] });
const cats = (fs: LintFinding[]) => fs.map((f) => f.category);

describe('lintBoundaries: one positive and one negative per category', () => {
  const cases: [NoGoCategory, string, string][] = [
    ['children', 'Heute bastle ich mit meiner Tochter.', 'Heute bastle ich allein.'],
    ['family_conflict', 'Der Streit mit meinem Bruder war laut.', 'Mein Bruder hat mir den Hobel geliehen.'],
    ['employer', 'Mein Chef hat das nicht gesehen.', 'Ich habe das nicht gesehen.'],
    ['medical', 'Nach der Diagnose wurde alles anders.', 'Nach dem Umzug wurde alles anders.'],
    ['home_location', 'Komm vorbei in der Lindenstraße 12.', 'Komm vorbei in der Werkstatt.'],
    ['faked_expertise', 'Als Expertin sage ich dir: so geht das.', 'Als Anfängerin sage ich dir: so geht das.'],
    ['custom', 'Das habe ich bei Musterfirma GmbH gelernt.', 'Das habe ich bei einem Kurs gelernt.'],
  ];
  for (const [cat, pos, neg] of cases)
    it(cat, () => {
      expect(cats(lint(pos, { terms: FIXTURE_SENSITIVE_TERMS }))).toContain(cat);
      expect(lint(neg, { terms: FIXTURE_SENSITIVE_TERMS })).toEqual([]);
    });

  it('home_location: postcode + place and „wohne in“ + a capitalised word', () => {
    expect(cats(lint('Ich bin in 12345 Beispielort aufgewachsen.'))).toEqual(['home_location']);
    expect(cats(lint('Ich wohne in Musterhausen.'))).toEqual(['home_location']);
    expect(cats(lint('Treffpunkt: Hauptstr. 5'))).toEqual(['home_location']);
  });
});

describe('lintBoundaries: rules', () => {
  it('does not flag „Kindheit“ (whole words only)', () => {
    expect(lint('Meine Kindheit am Meer war schön.')).toEqual([]);
    expect(cats(lint('Ein Kind am Meer.'))).toEqual(['children']);
  });

  it('family + conflict only when both occur in the same sentence', () => {
    expect(lint('Meine Mutter hat angerufen. Der Streit um den Parkplatz war absurd.')).toEqual([]);
    expect(cats(lint('Meine Mutter und der Streit um den Parkplatz.'))).toEqual(['family_conflict']);
  });

  it('a custom finding never contains the term in message or excerpt; the offsets point at the term', () => {
    const text = 'Gestern war ich wieder bei Musterfirma GmbH und habe gefeilt.';
    const [f] = lint(text, { terms: FIXTURE_SENSITIVE_TERMS, field: 'scenes[1].dialogue' });
    expect(f).toMatchObject({ category: 'custom', field: 'scenes[1].dialogue' });
    expect(text.slice(f!.start, f!.end)).toBe('Musterfirma GmbH');
    expect(f!.message).not.toMatch(/Musterfirma/i);
    expect(f!.excerpt).not.toMatch(/Musterfirma/i);
    expect(f!.excerpt).toContain('[Begriff aus deiner Liste]');
    expect(f!.message).toMatch(/^Grenze berührt \(Kategorie „eigene Liste“\) in Szene 2 \(Dialog\): „/);
    // a term cut by the ±30 window is masked whole, never half shown
    const long = `${'x'.repeat(40)} Musterfirma GmbH ${'y'.repeat(10)} Kind ${'z'.repeat(5)}`;
    for (const g of lint(long, { terms: FIXTURE_SENSITIVE_TERMS })) expect(g.excerpt).not.toMatch(/Musterf|GmbH/);
  });

  it('nested and partly overlapping terms are masked as one, in excerpt and message', () => {
    const nested: SensitiveTerm[] = [{ term: 'Musterfirma', category: 'employer' }, { term: 'Musterfirma GmbH', category: 'employer' }];
    const text = 'Ich war bei Musterfirma GmbH angestellt.';
    const fs = lint(text, { terms: nested });
    expect(fs).toHaveLength(1);
    expect(text.slice(fs[0]!.start, fs[0]!.end)).toBe('Musterfirma GmbH');
    expect(fs[0]!.excerpt).toBe('Ich war bei [Begriff aus deiner Liste] angestellt.');
    expect(fs[0]!.message).not.toMatch(/Musterfirma|GmbH/);
    // two terms that overlap but start at different points
    const overlap: SensitiveTerm[] = [{ term: 'Anna Beispiel', category: 'custom' }, { term: 'Beispiel Werk', category: 'custom' }];
    const t2 = 'Gestern bei Anna Beispiel Werk gewesen. Kind dabei.';
    for (const f of lint(t2, { terms: overlap })) {
      expect(f.excerpt).not.toMatch(/Anna|Beispiel|Werk/);
      expect(f.message).not.toMatch(/Anna|Beispiel|Werk/);
    }
    // the window edge falls inside a merged range: the whole range is masked
    const edge = `${'x'.repeat(29)} Anna Beispiel Werk ${'y'.repeat(40)} Kind.`;
    for (const f of lint(edge, { terms: overlap })) expect(f.excerpt).not.toMatch(/Anna|Beispiel|Werk|eispiel/);
  });

  it('client projects run only `custom` and `home_location`', () => {
    const text = 'Mein Chef hat eine Diagnose. Ich wohne in Beispielstadt. Musterfirma GmbH zahlt.';
    expect(new Set(cats(lint(text, { kind: 'UGC_CLIENT', terms: FIXTURE_SENSITIVE_TERMS })))).toEqual(new Set(['home_location', 'custom']));
    expect(new Set(cats(lint(text, { terms: FIXTURE_SENSITIVE_TERMS })))).toEqual(new Set(['employer', 'medical', 'home_location', 'custom']));
    expect(lint('Mein Chef findet das Garn gut.', { kind: 'UGC_CLIENT' })).toEqual([]);
  });

  it('the fingerprint is stable when other sentences change and changes with its own sentence', () => {
    const a = lint('Erster Satz. Mein Chef schaut zu. Letzter Satz.')[0]!;
    const b = lint('Ganz anderer Anfang!  Mein   Chef schaut zu.\nNeues Ende')[0]!;
    const c = lint('Erster Satz. Mein Chef schaut weg. Letzter Satz.')[0]!;
    expect(a.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(c.fingerprint).not.toBe(a.fingerprint);
    expect(a.fingerprint).toBe(sentenceFingerprint('employer', ' Mein Chef schaut zu'));
  });

  it('the negative corpus gives zero findings for a personal project', () => {
    for (const s of LINT_NEGATIVE_CORPUS) expect(lint(s, { terms: FIXTURE_SENSITIVE_TERMS }), s).toEqual([]);
    expect(LINT_NEGATIVE_CORPUS.length).toBeGreaterThanOrEqual(30);
  });
});

describe('field extractors', () => {
  it('name the fields of concept, script, copy, storyboard and edit plan', () => {
    expect(conceptLintParts({ title: 't', hook: 'h', hookVariants: ['a', 'b'], angle: 'w', structure: ['s'], cta: 'c' }).map((p) => p.field))
      .toEqual(['title', 'hook', 'hookVariants[0]', 'hookVariants[1]', 'angle', 'structure[0]', 'cta']);
    expect(scriptLintParts({ hookVariants: ['a'], selectedHook: 'a', cta: 'c', scenes: [{ dialogue: 'd', onScreenText: 'o' }] }).map((p) => p.field))
      .toEqual(['hookVariants[0]', 'selectedHook', 'cta', 'scenes[0].dialogue', 'scenes[0].onScreenText']);
    expect(copyLintParts({ caption: 'c', coverText: 'v', altText: 'a', hashtags: ['#x'] }).map((p) => p.field)).toEqual(['caption', 'coverText', 'altText', 'hashtags[0]']);
    expect(storyboardLintParts({ aiAssetBriefs: [{ prompt: 'p' }] }).map((p) => p.field)).toEqual(['aiAssetBriefs[0].prompt']);
    expect(editPlanLintParts({ hook: { text: 'h' }, clips: [{ subtitle: 's', overlays: [{ text: 'o' }] }] }).map((p) => p.field))
      .toEqual(['hook.text', 'clips[0].overlays[0].text', 'clips[0].subtitle']);
    const [f] = lintBoundaries(storyboardLintParts({ aiAssetBriefs: [{ prompt: 'Close-up einer Therapie-Sitzung, Medikament auf dem Tisch' }] }), { projectKind: 'PERSONAL_CONTENT', terms: [] });
    expect(f).toMatchObject({ category: 'medical', field: 'aiAssetBriefs[0].prompt' });
    expect(f!.message).toContain('KI-Asset-Brief 1');
  });
});
