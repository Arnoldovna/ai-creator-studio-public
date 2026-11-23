import { describe, expect, it } from 'vitest';
import { disclosureLabels } from '../src/edit';
import { hookLayout, lookKey, OVERLAY_FONTS, overlayAss, styleTokens, type OverlayKind, type Slot, type TimedOverlay } from '../src/overlays';
import { buildAss } from '../src/transcript';

/**
 * Etappe 14, E4: legacy parity. The snapshots in __snapshots__/legacyLook.test.ts.snap were written with the code of
 * Etappe 11 (before `rules.design` existed). Style Bible versions without `rules.design`, render looks stored before
 * Etappe 14 and the placeholder must keep exactly these tokens, `lookKey`s and ASS bytes, so approved renders stay valid.
 * Never update these snapshots to make a change pass.
 */
const SLOTS: Slot[] = ['upper', 'center', 'lower'];
const KINDS: OverlayKind[] = ['lower_third', 'keyword', 'arrow', 'frame'];
const timed = (o: Partial<TimedOverlay>): TimedOverlay => ({ clip: 0, index: 0, kind: 'keyword', text: 'Wolle', slot: 'center', direction: 'down', startSec: 0, endSec: 2, ...o });

const versions = [
  null,
  { id: 'sb-draft', version: 2, approvedAt: null, rules: { visual: { palette: ['#C8553D', '#20302A'] } } },
  { id: 'sb-empty', version: 3, approvedAt: '2026-11-01T10:00:00.000Z', rules: { visual: { palette: [] } } },
  { id: 'sb-one', version: 4, approvedAt: '2026-11-01T10:00:00.000Z', rules: { visual: { palette: ['#ffcc00'] } } },
  { id: 'sb-two', version: 5, approvedAt: '2026-11-01T10:00:00.000Z', rules: { visual: { palette: ['#C8553D', '#F4E9D8', 'kaputt', '#112233'] } } },
  { id: 'sb-dark', version: 6, approvedAt: '2026-11-01T10:00:00.000Z', rules: { visual: { palette: ['#20302A', '#C8553D'] } } },
];

describe('legacy looks (no rules.design) are unchanged', () => {
  it('tokens and lookKey of every legacy version and font', () => {
    const out = versions.flatMap((v) => OVERLAY_FONTS.map((f) => {
      const t = styleTokens(v, f);
      return { t, key: lookKey(t) };
    }));
    expect(out).toMatchSnapshot();
  });

  it('ASS of hook, every overlay kind, subtitles and the AI label', () => {
    const overlays = [
      ...KINDS.map((kind, i) => timed({ index: i, kind, slot: SLOTS[i % 3]!, text: kind === 'lower_third' ? 'Carola, Strickerin' : 'Wolle & Garn', startSec: i, endSec: i + 2 })),
      timed({ index: 4, kind: 'arrow', direction: 'left', slot: 'upper', startSec: 3, endSec: 4 }),
      timed({ index: 5, kind: 'keyword', text: '{\\pos(0,0)}böse', slot: 'lower', startSec: 5, endSec: 6 }),
    ];
    const hook = { text: 'So färbst du Wolle mit Zwiebelschalen', startSec: 0, endSec: 2.5, layout: hookLayout('So färbst du Wolle mit Zwiebelschalen', 'upper')! };
    const labels = disclosureLabels([{ origin: 'generated', inSec: 0, outSec: 3 }]);
    const files = versions.slice(0, 2).concat(versions.slice(4)).flatMap((v) => (['Avenir Next', 'Georgia'] as const).map((f) =>
      buildAss([{ startSec: 0, endSec: 2, text: 'Hallo zusammen' }], { labels, overlays: overlayAss({ overlays, hook }, styleTokens(v, f)) })));
    expect(files).toMatchSnapshot();
  });
});
