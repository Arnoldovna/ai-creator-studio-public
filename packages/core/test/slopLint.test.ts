import { describe, expect, it } from 'vitest';
import { AD_DISCLOSURE, AI_DISCLOSURE, findProtectedLabels, maskProtectedLabels, PROTECTED_LABELS, slopHints } from '../src';

const kinds = (text: string, where: Parameters<typeof slopHints>[1] = 'caption') => slopHints(text, where).map((h) => h.kind);

describe('Anti-Slop-Hinweise (nicht blockierend)', () => {
  it('finds the German patterns', () => {
    expect(kinds('Das ist nicht nur Wolle, sondern ein Lebensgefühl.')).toContain('binary_contrast');
    expect(kinds('Es geht nicht um Perfektion. Es geht um Freude.')).toContain('binary_contrast');
    expect(kinds('Ich habe es ausprobiert. Das ändert alles.')).toContain('fake_kicker');
    expect(kinds('Das Ergebnis? Ein Pullover.')).toContain('fake_kicker');
    expect(kinds('Hier ist die Sache: niemand strickt mehr.')).toContain('fake_kicker');
    expect(kinds('Kommentiere „WOLLE“ und ich schick dir die Anleitung.')).toContain('engagement_bait');
    expect(kinds('Tagge jemanden, der das braucht!')).toContain('engagement_bait');
    expect(kinds('Folge mir für mehr Tipps.')).toContain('engagement_bait');
    expect(kinds('In der heutigen schnelllebigen Welt lass uns eintauchen.')).toContain('stock_phrase');
    expect(kinds('Ruhe — für dich', 'overlay')).toContain('dash');
    expect(kinds('Eins – zwei – drei – vier, ein langer Absatz mit vielen Strichen.', 'script')).toContain('dash');
    expect(kinds('Ich stand auf.\nIch strickte.\nIch zweifelte.\nIch machte weiter.\nUnd es wurde gut.', 'caption')).toContain('broetry');
    expect(kinds('🧶 Wolle\n✂️ Schere\n📏 Maßband', 'caption')).toContain('emoji_bullets');
  });
  it('plain text in her voice gets no hint; the lint never changes the text', () => {
    const text = 'Heute zeige ich dir meinen ersten Pullover. Der linke Ärmel ist zu lang, und das bleibt so.';
    expect(slopHints(text, 'caption')).toEqual([]);
    const copy = `${text}`;
    slopHints(text, 'chat');
    expect(text).toBe(copy);
  });
  it('„Anzeige“, „KI-generiert“, #ad, „Werbung“ are never touched or reported', () => {
    for (const label of ['Anzeige', 'KI-generiert', '#ad', 'Werbung', '#werbung', 'unbezahlte Werbung', AI_DISCLOSURE, AD_DISCLOSURE])
      expect(findProtectedLabels(`Text ${label} Text`), label).toEqual([label.toLowerCase()]);
    // a text made only of labels: no hints of any kind (also not as broetry or dashes)
    const labels = 'Anzeige\nWerbung\nKI-generiert\n#ad\n#werbung\nAnzeige · Werbung';
    expect(slopHints(labels, 'caption')).toEqual([]);
    expect(slopHints(labels, 'overlay')).toEqual([]);
    // mixed with real slop: the slop is reported, no excerpt contains a label
    const mixed = 'Anzeige · Das ist nicht nur Wolle, sondern Liebe. Kommentiere „JA“! #ad KI-generiert';
    const hints = slopHints(mixed, 'caption');
    expect(hints.map((h) => h.kind)).toEqual(expect.arrayContaining(['binary_contrast', 'engagement_bait']));
    for (const h of hints) for (const l of ['Anzeige', '#ad', 'KI-generiert', 'Werbung']) expect(h.excerpt).not.toContain(l);
    // a pattern that would run through a label is not reported at all
    expect(slopHints('Das ist nicht nur Werbung, sondern Liebe.', 'caption')).toEqual([]);
    expect(maskProtectedLabels(mixed)).toHaveLength(mixed.length);
    // `#ad` inside another hashtag is not a label; the list is fixed
    expect(findProtectedLabels('#adventskalender')).toEqual([]);
    expect(PROTECTED_LABELS).toEqual(expect.arrayContaining(['Anzeige', 'Werbung', 'KI-generiert', '#ad']));
  });
});
