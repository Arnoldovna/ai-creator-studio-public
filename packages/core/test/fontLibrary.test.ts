import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyFontLicense, CURATED_GOOGLE_FONTS, englishFullName, faceFromName, fcWeightToCss, googleCssUrl, googleLicenseNote, parseFcList, parseGoogleCss, parseGoogleMetadata,
  parseSystemProfiler, searchFamilies, searchGoogleFonts,
} from '../src/fontCatalog';
import { DesignSystem, defaultPreset, defaultTypography, resolveDesignLook, resolveElementFont } from '../src/designSystem';
import { parseFontFile } from '../src/fontFile';
import { fontFallbacks } from '../src/overlays';

const fx = (f: string) => readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

/** Etappe 16b: font library – Mac enumeration, Google catalogue, licence, Mac fonts in the design system. */
describe('installed Mac fonts', () => {
  it('parses fc-list output: families with faces, CSS weights, italics, hidden and unsafe names', () => {
    const fams = parseFcList(fx('fc-list.txt'));
    expect(fams.map((f) => f.family)).toEqual(['Avenir Next', 'Curly Font', 'Georgia', 'Impact', 'Rockwell']);
    const rock = fams.find((f) => f.family === 'Rockwell')!;
    expect(rock.faces.map((f) => [f.postscriptName, f.weight, f.italic, f.ref])).toEqual([
      ['Rockwell-Regular', 400, false, 'mac:Rockwell-Regular'], ['Rockwell-Bold', 700, false, 'mac:Rockwell-Bold'],
      ['Rockwell-Italic', 400, true, 'mac:Rockwell-Italic'], ['Rockwell-BoldItalic', 700, true, 'mac:Rockwell-BoldItalic'],
    ]);
    // a PostScript name libass/ASS cannot carry safely is listed but not selectable
    expect(fams.find((f) => f.family === 'Curly Font')!.faces[0]!.ref).toBeNull();
    // upright faces first, by weight
    expect(fams.find((f) => f.family === 'Avenir Next')!.faces[0]!.italic).toBe(false);
    // the ASS gets the English full name (libass/CoreText misses some TrueType faces by PostScript name, e.g. Georgia-Bold)
    expect(fams.find((f) => f.family === 'Georgia')!.faces[0]).toMatchObject({ postscriptName: 'Georgia-Bold', assName: 'Georgia Bold', ref: 'mac:Georgia-Bold', weight: 700 });
    expect(englishFullName('Rockwell-Bold,Rockwell Bold', 'en,en', 'Rockwell-Bold')).toBe('Rockwell Bold');
    expect([0, 50, 80, 100, 180, 200, 210].map(fcWeightToCss)).toEqual([100, 300, 400, 500, 600, 700, 900]);
  });

  it('parses system_profiler JSON as fallback (weights from the names, disabled and hidden fonts skipped)', () => {
    const fams = parseSystemProfiler(fx('system-profiler-fonts.json'));
    expect(fams.map((f) => f.family)).toEqual(['Rockwell']);
    expect(fams[0]!.faces.map((f) => [f.postscriptName, f.weight, f.italic])).toEqual([['Rockwell-Regular', 400, false], ['Rockwell-Bold', 700, false], ['Rockwell-Italic', 400, true]]);
    expect(parseSystemProfiler('kein json')).toEqual([]);
    expect(faceFromName('Didot-HTF-SemiBold')).toEqual({ weight: 600, italic: false });
  });

  it('searches families by every word, accent-insensitive', () => {
    const fams = parseFcList(fx('fc-list.txt'));
    expect(searchFamilies(fams, 'avenir').map((f) => f.family)).toEqual(['Avenir Next']);
    expect(searchFamilies(fams, 'ROCK well').map((f) => f.family)).toEqual(['Rockwell']);
    expect(searchFamilies(fams, '', 2)).toHaveLength(2);
  });

  it('a Mac font in a type role: English full name in the ASS (PostScript name kept for the check), bold from the face, italic only when chosen', () => {
    const t = defaultTypography();
    const design = DesignSystem.parse({
      colors: Object.fromEntries(['primary', 'accent', 'surface', 'onSurface', 'onAccent', 'onVideo', 'background'].map((r) => [r, { hex: r.startsWith('on') ? '#FFFFFF' : '#203040' }])),
      typography: {
        ...t,
        hook: { ...t.hook, font: 'mac:Rockwell-Bold', face: { family: 'Rockwell', style: 'Bold', weight: 700, italic: false, assName: 'Rockwell Bold' }, animation: 'pop' },
        keyword: { ...t.keyword, font: 'mac:Rockwell-Italic', face: { family: 'Rockwell', style: 'Italic', weight: 400, italic: true } },
        subtitle: { ...t.subtitle, subtitleMode: 'karaoke', wordsPerLine: 2 },
      },
      presets: [defaultPreset()], defaultPresetId: 'marke',
    });
    const { look } = resolveDesignLook(design);
    expect(look.hook.type).toEqual({ family: 'Rockwell', assName: 'Rockwell Bold', bold: true, scale: 1, textCase: 'none', custom: false, mac: true, postscriptName: 'Rockwell-Bold' });
    expect(look.keyword.type).toMatchObject({ assName: 'Rockwell-Italic', bold: false, italic: true, mac: true });
    expect(look.anim).toEqual({ hook: 'pop' });
    expect([look.subtitleMode, look.wordsPerLine]).toEqual(['karaoke', 2]);
    // without the new fields nothing is added (older designs keep their JSON and lookKey)
    const plain = resolveDesignLook(DesignSystem.parse({ ...design, typography: defaultTypography() })).look;
    expect(Object.keys(plain)).not.toContain('anim');
    expect(Object.keys(plain)).not.toContain('subtitleMode');
    expect(Object.keys(plain.hook.type)).toEqual(['family', 'assName', 'bold', 'scale', 'textCase', 'custom']);
    // an unsafe or unknown reference is refused by the schema
    expect(DesignSystem.safeParse({ ...design, typography: { ...t, hook: { ...t.hook, font: 'mac:Evil}{\\fn' } } }).success).toBe(false);
    expect(resolveElementFont({ ref: 'custom:weg' }, [], [])).toBeNull();
  });

  it('the render check wants exactly the chosen face (PostScript name), not only the family', () => {
    const ok = 'fontselect: (Rockwell-Bold, 700, 0) -> /System/Library/Fonts/Supplemental/Rockwell.ttc, 2, Rockwell-Bold';
    expect(fontFallbacks(ok, [{ name: 'Rockwell-Bold', postscriptName: 'Rockwell-Bold' }])).toEqual([]);
    const fallback = 'fontselect: (Rockwell-Bold, 700, 0) -> /System/Library/Fonts/Helvetica.ttc, 1, Helvetica-Bold';
    expect(fontFallbacks(fallback)).toEqual(['Schrift „Rockwell-Bold“ nicht gefunden – libass hat „Helvetica-Bold“ genommen.']);
    // the family resolves, but to another face than the one she chose
    const otherFace = 'fontselect: (Rockwell, 700, 0) -> /System/Library/Fonts/Supplemental/Rockwell.ttc, 0, Rockwell-Regular';
    expect(fontFallbacks(otherFace)).toEqual([]);
    expect(fontFallbacks(otherFace, [{ name: 'Rockwell', postscriptName: 'Rockwell-Bold' }])).toEqual(['Schrift „Rockwell“: libass hat „Rockwell-Regular“ statt „Rockwell-Bold“ genommen.']);
  });
});

describe('Google Fonts catalogue', () => {
  it('parses the public metadata (prefix, categories, upright weights; brand and non-ASCII names skipped)', () => {
    const list = parseGoogleMetadata(fx('google-metadata.json'));
    const names = list.map((f) => f.family);
    expect(names).toEqual(expect.arrayContaining(['Bebas Neue', 'Montserrat', 'Caveat', 'Playfair Display', 'Roboto Mono', 'Anton', 'Shrikhand']));
    expect(names).not.toContain('Noto Color Emoji');
    expect(names.some((n) => n.includes('Ñ'))).toBe(false);
    const by = (n: string) => list.find((f) => f.family === n)!;
    expect(by('Bebas Neue')).toMatchObject({ category: 'sans', weights: [400] });
    expect(by('Caveat').category).toBe('handwriting');
    expect(by('Roboto Mono').category).toBe('mono');
    expect(by('Shrikhand').category).toBe('display');
    expect(by('Playfair Display').category).toBe('serif');
    expect(by('Montserrat').weights).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900]);
    // most popular first, category filter, search
    expect(searchGoogleFonts(list, { category: 'serif' }).map((f) => f.family)).toEqual(['Playfair Display']);
    expect(searchGoogleFonts(list, { query: 'bebas' }).map((f) => f.family)).toEqual(['Bebas Neue']);
    expect(() => parseGoogleMetadata('{"x":1}')).toThrow(/Familienliste/);
    expect(CURATED_GOOGLE_FONTS).toContain('Bebas Neue');
  });

  it('builds the CSS2 URL and reads the TTF URLs of a response', () => {
    expect(googleCssUrl('https://fonts.googleapis.com/css2', 'Bebas Neue', [400])).toBe('https://fonts.googleapis.com/css2?family=Bebas+Neue:wght@400&display=swap');
    expect(googleCssUrl('https://fonts.googleapis.com/css2', 'Montserrat', [700, 400, 700], 'Aa')).toBe('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap&text=Aa');
    expect(() => googleCssUrl('https://x', "Evil'); x", [400])).toThrow();
    expect(parseGoogleCss(fx('google-css2.css'))).toEqual([
      { family: 'Montserrat', weight: 400, italic: false, url: 'https://fonts.gstatic.com/s/montserrat/v31/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCtr6Ew-.ttf' },
      { family: 'Montserrat', weight: 700, italic: false, url: 'https://fonts.gstatic.com/s/montserrat/v31/JTUHjIg1_i6t8kCHKm4532VJOt5-QNFgpCuM70w-.ttf' },
    ]);
  });

  it('recognises the licence from the font file and writes the note automatically', () => {
    const bytes = new Uint8Array(readFileSync(path.join(__dirname, '../../../apps/web/test/fixtures/fonts/BebasNeue-Regular.ttf')));
    const info = parseFontFile(bytes);
    expect(info).toMatchObject({ family: 'Bebas Neue', postscriptName: 'BebasNeue-Regular', assName: 'Bebas Neue Regular', italic: false, weight: 400 });
    const lic = classifyFontLicense(info.licenseText, info.licenseUrl);
    expect(lic?.id).toBe('OFL-1.1');
    expect(classifyFontLicense('Licensed under the Apache License, Version 2.0', '')?.id).toBe('Apache-2.0');
    expect(classifyFontLicense('All rights reserved', '')).toBeNull();
    expect(googleLicenseNote(lic!, 'Bebas Neue', '2025-09-16', 'https://fonts.gstatic.com/s/bebasneue/v16/a.ttf'))
      .toBe('SIL Open Font License 1.1 (https://openfontlicense.org) · Google Fonts „Bebas Neue“ (Stand 2025-09-16) · https://fonts.google.com/specimen/Bebas+Neue · Datei https://fonts.gstatic.com/s/bebasneue/v16/a.ttf');
  });
});
