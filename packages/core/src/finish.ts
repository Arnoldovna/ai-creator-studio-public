/**
 * Etappe 17: the finish package for CapCut and other editors (pure and deterministic).
 * The studio delivers the cut, the dramaturgy, the hook choice and the subtitles; the external editor does the text polish.
 * - SRT from the render's own subtitle cues (`cuesForTimeline`, output timeline), sentence-wise and word-wise.
 * - A text sheet (hook, keywords, lower thirds, arrows, frames) with times, positions and the look of „Meine Marke“.
 * - FCPXML (one clip: the clean video, plus markers) for DaVinci Resolve / Final Cut.
 * - The German guide with the disclosure notes (the AI label stays burned into the clean video).
 * - QA „fehlende Wörter“: the words she kept in the cut vs. what a fresh transcription of the render heard.
 * Text from transcripts and overlays is untrusted data: it is only escaped and written, never interpreted.
 */
import { z } from 'zod';
import { AD_DISCLOSURE, AI_DISCLOSURE } from './agents/scriptAgents';
import { overlayBox, PLAY_RES, type Box } from './overlayLayout';
import { elementAnimSpec, elementFontOf, elementSpec, lookFit, timedElements, type ClipOverlay, type LookTokens, type PlanHook } from './overlays';
import type { ResolvedType } from './designSystem';
import { overlayFontSize } from './overlayLayout';
import type { SubtitleCue, TranscriptWord } from './transcript';
import type { Timeline } from './timeline';
import type { ClipImage } from './imageLayer';
import { timedImages } from './imageLayer';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const pct = (n: number) => Math.round(n * 1000) / 10;

// ---------- Times ----------

/** SRT time `HH:MM:SS,mmm` (whole milliseconds). */
export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000), x = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(x).padStart(3, '0')}`;
}

/** Readable time `m:ss.mmm` for the text sheet („0:03.250“). */
export function sheetTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const m = Math.floor(ms / 60_000), s = Math.floor((ms % 60_000) / 1000), x = ms % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
}

// ---------- SRT ----------

/**
 * Cue text for SRT: control characters removed, line breaks folded to spaces (an empty line would end the block), the
 * arrow `-->` neutralised, and `<`/`>` replaced (several players read them as formatting tags).
 */
export function srtText(text: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/-->/g, '→').replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * SRT file (UTF-8, CRLF line ends as in the original SubRip format) from cues on the output timeline. Cues are sorted,
 * empty ones dropped, and a cue never ends after the next one starts (some importers refuse overlaps).
 */
export function toSrt(cues: readonly SubtitleCue[]): string {
  const list = cues
    .map((c) => ({ startSec: r3(c.startSec), endSec: r3(c.endSec), text: srtText(c.text) }))
    .filter((c) => c.text && c.endSec - c.startSec >= 0.001)
    .sort((a, b) => a.startSec - b.startSec);
  for (let i = 0; i + 1 < list.length; i++) if (list[i]!.endSec > list[i + 1]!.startSec) list[i]!.endSec = list[i + 1]!.startSec;
  return list.filter((c) => c.endSec > c.startSec).map((c, i) => `${i + 1}\r\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\r\n${c.text}\r\n`).join('\r\n');
}

// ---------- Text sheet ----------

/** Position in words from the centre of a box on the 1080×1920 picture („oben links“, „Mitte mittig“, „untere Mitte rechts“). */
export function positionWords(b: Box): string {
  const cx = (b.x0 + b.x1) / 2 / PLAY_RES.width, cy = (b.y0 + b.y1) / 2 / PLAY_RES.height;
  const v = cy < 0.25 ? 'oben' : cy < 0.45 ? 'obere Mitte' : cy < 0.55 ? 'Mitte' : cy < 0.75 ? 'untere Mitte' : 'unten';
  const h = cx < 0.4 ? 'links' : cx > 0.6 ? 'rechts' : 'mittig';
  return `${v} ${h}`;
}

const FinishPosition = z.object({
  words: z.string(),
  /** Centre of the box in % of width/height (0 = left/top). */
  xPct: z.number().min(0).max(100), yPct: z.number().min(0).max(100),
  widthPct: z.number().min(0).max(100), heightPct: z.number().min(0).max(100),
  /** The slot it sits in, or `frei` for a free position. */
  slot: z.enum(['upper', 'center', 'lower', 'frei']),
});
const FinishStyle = z.object({
  presetId: z.string(), presetName: z.string(),
  font: z.string().nullable(), bold: z.boolean().nullable(), textCase: z.enum(['none', 'upper', 'lower']).nullable(),
  /** Font size in px on the 1080×1920 picture (as the studio draws it; CapCut uses its own units). */
  fontSizePx: z.number().nullable(),
  shape: z.string().nullable(),
  fill: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(), textColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable(),
  /** Etappe 16b: `pop` (80 → 105 → 100 % with a short fade) besides fade and none. */
  animation: z.enum(['fade', 'none', 'pop']),
  /** Etappe 16b: where the font comes from (Mac, Google Fonts with licence link, her own file, studio list), to rebuild it in CapCut. */
  fontInfo: z.object({
    name: z.string(), postscriptName: z.string().nullable(),
    source: z.enum(['studio', 'mac', 'google', 'eigene']),
    license: z.string().nullable(), licenseUrl: z.string().nullable(), sourceUrl: z.string().nullable(),
  }).nullable().optional(),
});
/** Font origin the server knows for a resolved font (Google/own font records); null = a studio or Mac font. */
export type FontOriginLookup = (t: ResolvedType) => { source: 'google' | 'eigene'; postscriptName: string; license: string; licenseUrl: string | null; sourceUrl: string | null } | null;
export const FinishTextItem = z.object({
  kind: z.enum(['hook', 'keyword', 'lower_third', 'arrow', 'frame']),
  label: z.string(),
  text: z.string(),
  startSec: z.number().min(0), endSec: z.number().min(0),
  start: z.string(), end: z.string(),
  /** 1-based clip of the cut (the hook belongs to the whole cut: null). */
  clip: z.number().int().min(1).nullable(),
  direction: z.enum(['left', 'right', 'up', 'down']).nullable(),
  position: FinishPosition,
  style: FinishStyle,
});
export type FinishTextItem = z.infer<typeof FinishTextItem>;
export const FinishImageItem = z.object({
  referenceId: z.string(), name: z.string(), file: z.string().nullable(),
  startSec: z.number().min(0), endSec: z.number().min(0), start: z.string(), end: z.string(),
  /** Burned into video-clean.mp4, or left out (she places it herself; then `file` is in the package). */
  inCleanVideo: z.boolean(),
  generated: z.boolean(),
  position: FinishPosition.omit({ slot: true }),
});
export type FinishImageItem = z.infer<typeof FinishImageItem>;
/** `texte.json`: everything she types or rebuilds in CapCut, versioned. */
export const FinishTexts = z.object({
  format: z.literal('ai-creator-studio/texte'),
  version: z.literal(1),
  durationSec: z.number().min(0),
  picture: z.object({ width: z.literal(1080), height: z.literal(1920), fps: z.literal(30) }),
  look: z.object({ label: z.string(), source: z.enum(['style_bible', 'placeholder']) }),
  items: z.array(FinishTextItem),
  images: z.array(FinishImageItem),
  disclosures: z.array(z.string()),
  /** Etappe 16b: how the subtitles are animated (absent = lines, as before). */
  subtitles: z.object({ mode: z.enum(['lines', 'karaoke', 'word']), wordsPerLine: z.number().int().min(1).max(6), highlight: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable() }).optional(),
});
export type FinishTexts = z.infer<typeof FinishTexts>;

const KIND_LABEL: Record<FinishTextItem['kind'], string> = { hook: 'Hook', keyword: 'Keyword', lower_third: 'Bauchbinde', arrow: 'Pfeil', frame: 'Rahmen' };
const DIRECTION_LABEL = { left: 'nach links', right: 'nach rechts', up: 'nach oben', down: 'nach unten' } as const;

function position(b: Box, slot: FinishTextItem['position']['slot']): FinishTextItem['position'] {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return {
    words: positionWords(b), slot,
    xPct: clamp(pct((b.x0 + b.x1) / 2 / PLAY_RES.width)), yPct: clamp(pct((b.y0 + b.y1) / 2 / PLAY_RES.height)),
    widthPct: clamp(pct((b.x1 - b.x0) / PLAY_RES.width)), heightPct: clamp(pct((b.y1 - b.y0) / PLAY_RES.height)),
  };
}

/**
 * The text sheet of a cut: hook and overlays on the output timeline (the same `timedElements` as the render, so case and
 * size steps are applied), their boxes, and the look each element is drawn in (`elementSpec`: her preset, fonts, colours).
 * Images are listed with their times; `imagesInVideo` says whether video-clean.mp4 shows them.
 */
export function finishTexts(
  body: { clips: readonly { overlays?: readonly ClipOverlay[]; images?: readonly ClipImage[] }[]; hook?: PlanHook | null },
  tl: Timeline,
  look: LookTokens,
  opts: {
    disclosures: readonly string[]; imagesInVideo: boolean; image: (referenceId: string) => { name: string; generated: boolean; file: string | null };
    fontOrigin?: FontOriginLookup; subtitles?: { mode: 'lines' | 'karaoke' | 'word'; wordsPerLine: number; highlight: string | null } | null;
  },
): FinishTexts {
  const t = timedElements(body, tl, lookFit(look));
  const info = (r: ResolvedType) => {
    const o = opts.fontOrigin?.(r) ?? null;
    if (o) return { name: r.family, postscriptName: o.postscriptName, source: o.source, license: o.license, licenseUrl: o.licenseUrl, sourceUrl: o.sourceUrl };
    return { name: r.family, postscriptName: r.mac ? r.assName : null, source: r.mac ? 'mac' as const : 'studio' as const, license: null, licenseUrl: null, sourceUrl: null };
  };
  // the animation she sees: the element's own, else the role's default, else the style's fade/none
  const animName = (spec: { fadeInMs: number; scale: readonly { s: number }[] }): 'fade' | 'none' | 'pop' =>
    spec.scale.some((x) => x.s > 1) ? 'pop' : spec.fadeInMs > 0 ? 'fade' : 'none';
  const items: FinishTextItem[] = [];
  const times = (s: number, e: number) => ({ startSec: r3(s), endSec: r3(e), start: sheetTime(s), end: sheetTime(e) });
  if (t.hook) {
    const d = elementSpec(look, t.hook.presetId);
    const own = elementFontOf(look, t.hook.font);
    const ht = own ?? d.hook.type;
    items.push({
      kind: 'hook', label: KIND_LABEL.hook, text: t.hook.text, ...times(t.hook.startSec, t.hook.endSec), clip: null, direction: null,
      position: position(t.hook.layout.box, t.hook.pos ? 'frei' : (body.hook?.slot ?? 'upper')),
      style: { presetId: d.presetId, presetName: d.presetName, font: ht.family, bold: ht.bold, textCase: d.hook.type.textCase, fontSizePx: t.hook.layout.size, shape: d.hook.shape, fill: d.hook.fill, textColor: d.hook.text, animation: animName(elementAnimSpec('hook', t.hook.anim, d)), fontInfo: info(ht) },
    });
  }
  for (const o of t.overlays) {
    const d = elementSpec(look, o.presetId);
    const box = overlayBox(o);
    const slot = o.pos ? 'frei' : o.slot;
    const base = { kind: o.kind, label: KIND_LABEL[o.kind], text: o.text, ...times(o.startSec, o.endSec), clip: o.clip + 1, position: position(box, slot) };
    const common = { presetId: d.presetId, presetName: d.presetName, animation: animName(elementAnimSpec(o.kind, o.anim, d)) };
    if (o.kind === 'keyword' || o.kind === 'lower_third') {
      const r = o.kind === 'keyword' ? d.keyword : d.lowerThird;
      const ft = elementFontOf(look, o.font) ?? r.type;
      items.push({ ...base, direction: null, style: { ...common, font: ft.family, bold: ft.bold, textCase: r.type.textCase, fontSizePx: overlayFontSize(o.kind, o.text, o.scale), shape: r.shape, fill: r.fill, textColor: r.text, fontInfo: info(ft) } });
    } else {
      items.push({ ...base, direction: o.kind === 'arrow' ? o.direction : null, style: { ...common, font: null, bold: null, textCase: null, fontSizePx: null, shape: o.kind, fill: d.graphic, textColor: null } });
    }
  }
  items.sort((a, b) => a.startSec - b.startSec || (a.kind === 'hook' ? -1 : 0));
  const images = timedImages(body, tl).images.map((im): FinishImageItem => {
    const info = opts.image(im.referenceId);
    const p = position(im.box, 'frei');
    return {
      referenceId: im.referenceId, name: info.name, file: opts.imagesInVideo ? null : info.file, ...times(im.startSec, im.endSec),
      inCleanVideo: opts.imagesInVideo, generated: info.generated, position: { words: p.words, xPct: p.xPct, yPct: p.yPct, widthPct: p.widthPct, heightPct: p.heightPct },
    };
  });
  return FinishTexts.parse({
    format: 'ai-creator-studio/texte', version: 1, durationSec: r3(tl.durationSec), picture: { width: 1080, height: 1920, fps: 30 },
    look: { label: look.label, source: look.source }, items, images, disclosures: [...opts.disclosures],
    ...(opts.subtitles ? { subtitles: opts.subtitles } : {}),
  });
}

const CASE_LABEL = { none: '', upper: ', GROSSBUCHSTABEN', lower: ', kleinbuchstaben' } as const;
/** German decimal comma for the readable list („39,9 %“). */
const de = (n: number) => String(n).replace('.', ',');

/** `texte.txt`: the sheet as a readable German list to type along in CapCut. */
export function textsToTxt(s: FinishTexts, title: string): string {
  const lines = [
    `Texte zum Nachbauen – ${title}`,
    `Länge ${sheetTime(s.durationSec)} · Bild 1080 × 1920, 30 fps · Look: ${s.look.label}`,
    'Zeiten im fertigen Schnitt (Minute:Sekunde.Millisekunde). Positionen: Mitte der Box in % (0 % = links bzw. oben).',
    '',
  ];
  if (!s.items.length) lines.push('Keine Texte oder Grafiken im Schnitt.', '');
  s.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.label}${it.clip ? ` (Clip ${it.clip})` : ''}: ${it.text ? `„${it.text}“` : it.direction ? DIRECTION_LABEL[it.direction] : '–'}`);
    lines.push(`   Zeit: ${it.start} – ${it.end}`);
    lines.push(`   Position: ${it.position.words} (x ${de(it.position.xPct)} %, y ${de(it.position.yPct)} %, Breite ${de(it.position.widthPct)} %)${it.position.slot === 'frei' ? ', frei platziert' : ''}`);
    const st = it.style;
    const font = st.font ? `${st.font}${st.bold ? ' fett' : ''}${st.textCase ? CASE_LABEL[st.textCase] : ''}${st.fontSizePx ? `, ${st.fontSizePx} px im Studio` : ''}` : null;
    lines.push(`   Stil: ${st.presetName}${font ? ` · Schrift ${font}` : ''}${st.shape ? ` · Form ${st.shape}` : ''}${st.fill ? ` · Fläche ${st.fill}` : ''}${st.textColor ? ` · Text ${st.textColor}` : ''}${st.animation === 'fade' ? ' · ein-/ausblenden' : st.animation === 'pop' ? ' · Pop-in (80 → 105 → 100 %)' : ''}`);
    if (st.fontInfo?.source === 'google') lines.push(`   Schrift: Google Fonts „${st.fontInfo.name}“ · ${st.fontInfo.license ?? ''}${st.fontInfo.sourceUrl ? ` · ${st.fontInfo.sourceUrl}` : ''}`);
    else if (st.fontInfo?.source === 'mac') lines.push(`   Schrift: auf dem Mac installiert („${st.fontInfo.postscriptName}“) – in CapCut ggf. selbst hinzufügen`);
    lines.push('');
  });
  if (s.images.length) {
    lines.push('Bilder:');
    for (const im of s.images)
      lines.push(`- ${im.name}: ${im.start} – ${im.end}, ${im.position.words} (x ${de(im.position.xPct)} %, y ${de(im.position.yPct)} %, Breite ${de(im.position.widthPct)} %)${im.inCleanVideo ? ' – ist im video-clean.mp4' : ` – nicht im Video, Datei: ${im.file ?? '–'}`}${im.generated ? ' – KI-generiert: braucht das KI-Label' : ''}`);
    lines.push('');
  }
  if (s.disclosures.length) lines.push(`Kennzeichnung: ${s.disclosures.join(', ')} (siehe ANLEITUNG.md).`);
  return `${lines.join('\n').trimEnd()}\n`;
}

// ---------- FCPXML ----------

/** XML 1.0 attribute text: control characters removed, the five specials escaped. */
export function xmlAttr(s: string): string {
  // eslint-disable-next-line no-control-regex -- characters XML 1.0 does not allow
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
const frames = (sec: number) => Math.max(0, Math.round(sec * 30));
const rt = (n: number) => (n === 0 ? '0s' : `${n}/30s`);

/**
 * FCPXML 1.10 for DaVinci Resolve / Final Cut: one 1080×1920/30p sequence with the clean video as one clip, the texts as
 * markers at their times. The media path is relative to the package folder (`video-clean.mp4`); an editor that wants an
 * absolute path asks to relink it.
 */
export function buildFcpxml(o: { title: string; durationSec: number; hasAudio: boolean; videoFile: string; markers: readonly { startSec: number; text: string }[] }): string {
  const d = Math.max(1, frames(o.durationSec));
  const name = xmlAttr(o.title.slice(0, 120)) || 'Schnitt';
  const markers = o.markers
    .map((m) => ({ f: Math.min(d - 1, frames(m.startSec)), text: xmlAttr(m.text.replace(/\s+/g, ' ').slice(0, 200)) }))
    .filter((m) => m.text)
    .map((m) => `              <marker start="${rt(m.f)}" duration="1/30s" value="${m.text}"/>`);
  const audio = o.hasAudio ? ' hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"' : '';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE fcpxml>',
    '<fcpxml version="1.10">',
    '  <resources>',
    '    <format id="r1" frameDuration="1/30s" width="1080" height="1920" colorSpace="1-1-1 (Rec. 709)"/>',
    `    <asset id="r2" name="${xmlAttr(o.videoFile)}" start="0s" duration="${rt(d)}" hasVideo="1" format="r1"${audio}>`,
    `      <media-rep kind="original-media" src="${xmlAttr(o.videoFile)}"/>`,
    '    </asset>',
    '  </resources>',
    '  <library>',
    '    <event name="AI Creator Studio">',
    `      <project name="${name}">`,
    `        <sequence format="r1" duration="${rt(d)}" tcStart="0s" tcFormat="NDF"${o.hasAudio ? ' audioLayout="stereo" audioRate="48k"' : ''}>`,
    '          <spine>',
    `            <asset-clip ref="r2" offset="0s" name="${xmlAttr(o.videoFile)}" start="0s" duration="${rt(d)}" format="r1" tcFormat="NDF"${markers.length ? '' : '/'}>`,
    ...(markers.length ? [...markers, '            </asset-clip>'] : []),
    '          </spine>',
    '        </sequence>',
    '      </project>',
    '    </event>',
    '  </library>',
    '</fcpxml>',
    '',
  ].join('\n');
}

// ---------- Guide ----------

export interface GuideInput {
  title: string; durationSec: number; client: boolean; disclosures: readonly string[];
  /** The clean video carries the AI label (a generated clip or a generated image that it shows). */
  labelBurned: boolean;
  /** Generated images that are NOT in the clean video but in `bilder/` (she must label them herself if she uses them). */
  generatedImagesOutside: boolean;
  files: { videoWithText: boolean; wordSrt: boolean; alpha: boolean; fcpxml: boolean; caption: boolean; images: boolean; subtitles: boolean };
  imagesInVideo: boolean | null;
}

/** `ANLEITUNG.md`: short German steps „In CapCut fertigstellen“ plus the disclosure notes. Careful wording about CapCut. */
export function finishGuide(g: GuideInput): string {
  const f = g.files;
  const files = [
    `- \`video-clean.mp4\` – fertig geschnitten (Schnitte, Zoom, Ton), **ohne** eingebrannte Texte, Hook und Untertitel${g.imagesInVideo == null ? '' : g.imagesInVideo ? ', mit deinen Bild-Einblendungen' : ', ohne Bild-Einblendungen'}.${g.labelBurned ? ' Das KI-Label ist eingebrannt und bleibt drin.' : ''}`,
    f.videoWithText ? '- `video-mit-text.mp4` – der normale Render mit allen Texten, als Vorlage zum Vergleichen.' : null,
    f.subtitles ? '- `untertitel.srt` – die Untertitel des Schnitts (Satzweise, Zeiten im fertigen Schnitt).' : '- Keine Untertitel: im Schnitt gibt es weder Transkript noch eigenen Untertitel-Text.',
    f.wordSrt ? '- `untertitel-woerter.srt` – dieselben Untertitel Wort für Wort (für Wort-für-Wort-Stile).' : null,
    '- `texte.txt` und `texte.json` – Hook, Keywords, Bauchbinden und Pfeile mit Start/Ende, Position und Stil aus „Meine Marke“.',
    '- `cover.png` – Standbild vom Anfang (mit Hook und Texten, wie das Studio sie setzt).',
    f.alpha ? '- `overlays-alpha.mov` – nur die Text-/Grafik-Ebene mit Transparenz (ProRes 4444).' : null,
    f.images ? '- `bilder/` – die Bilder, die nicht im Video sind (Zeiten in `texte.txt`).' : null,
    f.caption ? '- `caption.txt` – die Caption aus dem Studio.' : null,
    f.fcpxml ? '- `projekt.fcpxml` – für DaVinci Resolve oder Final Cut (ein Clip plus Marker für die Texte; CapCut liest das nicht).' : null,
  ].filter(Boolean);
  const steps = [
    '1. In CapCut ein neues Projekt anlegen und `video-clean.mp4` importieren. Falls nötig das Format 9:16 einstellen.',
    f.subtitles
      ? `2. Untertitel: \`untertitel.srt\` importieren. In vielen CapCut-Versionen geht das über den Bereich für Text bzw. Untertitel („Untertitel importieren“ o. Ä.); Name und Ort des Menüs können je nach Version abweichen.${f.wordSrt ? ' Für Wort-für-Wort-Stile kannst du stattdessen `untertitel-woerter.srt` ausprobieren.' : ''}`
      : '2. Untertitel: im Studio gab es keine; in CapCut bei Bedarf selbst erzeugen.',
    '3. Texte: nach `texte.txt` setzen (Zeit, Position, Schrift, Farben). `video-mit-text.mp4` und `cover.png` zeigen, wie es im Studio aussah.',
    f.alpha ? '4. Optional: `overlays-alpha.mov` als zusätzliche Ebene über das Video legen. Ob die Transparenz übernommen wird, hängt vom Editor und von der CapCut-Version ab – das ist nicht geprüft. Sieht der Hintergrund schwarz aus, die Datei nicht verwenden und die Texte selbst setzen.' : '4. Musik und Feinschliff nach Wunsch.',
    `5. Export in 1080 × 1920, 30 fps. Länge des Schnitts: ${sheetTime(g.durationSec)}.`,
  ];
  const labels: string[] = [];
  if (g.labelBurned) labels.push(`- **KI-Label:** Das Video enthält KI-generierte Clips oder Bilder. Das Label „${AI_DISCLOSURE}“ ist oben links eingebrannt. Bitte nicht wegschneiden, herauszoomen, überdecken oder unkenntlich machen und keinen Text darüberlegen.`);
  else labels.push('- Dieser Schnitt enthält keine KI-generierten Clips oder Bilder; deshalb ist kein KI-Label eingebrannt. Fügst du in CapCut KI-Bilder, KI-Videos oder KI-Effekte hinzu, musst du das selbst kennzeichnen.');
  if (g.generatedImagesOutside) labels.push(`- Bilder in \`bilder/\`, die als KI-generiert markiert sind: Wenn du sie in CapCut einblendest, braucht das Video das Label „${AI_DISCLOSURE}“ (sichtbar, solange das Bild zu sehen ist).`);
  if (g.client) labels.push(`- **Kundenprojekt:** In die Caption gehört „${AD_DISCLOSURE}“, und auf Instagram zusätzlich die Kennzeichnung als bezahlte Partnerschaft, wenn der Beitrag eine Kooperation ist. Vom Kunden verlangte Hinweise bleiben drin.`);
  if (g.disclosures.length) labels.push(`- Kennzeichnungen dieses Schnitts laut Studio: ${g.disclosures.join(', ')}.`);
  labels.push('- Keine Kennzeichnung entfernen oder abschwächen, auch nicht in Caption oder Cover.');
  return [
    '# In CapCut fertigstellen',
    '',
    `Paket aus dem AI Creator Studio: ${g.title}`,
    '',
    '## Was drin ist',
    '',
    ...files,
    '',
    '## Schritte',
    '',
    ...steps,
    '',
    '## Kennzeichnung – bitte beachten',
    '',
    ...labels,
    '',
    '## Hinweise',
    '',
    '- CapCut liest keine Projekt- oder Timeline-Dateien aus anderen Programmen; deshalb kommen Video, Untertitel und Texte einzeln.',
    '- Die Menünamen in CapCut ändern sich zwischen Versionen. Diese Anleitung beschreibt den Ablauf, nicht jeden Klick.',
    '',
  ].join('\n');
}

// ---------- QA: missing words ----------

/** Word key for the comparison: lower case, ß → ss, letters and digits only. */
export const wordKey = (w: string) => w.toLowerCase().replace(/ß/g, 'ss').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');

const similar = (a: string, b: string) => {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  // inflection/recognition noise: same stem, at most two characters more or less („färben“/„färbe“)
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.startsWith(s) && l.length - s.length <= 2;
};

export interface MissingWordFinding {
  /** The word(s) of the cut that the fresh transcription did not hear, in order. */
  text: string;
  startSec: number; endSec: number;
  words: number;
  /** Lies within `edgeSec` of a cut, a clip boundary or the start/end: probably clipped by the cut. */
  atCut: boolean;
}
export interface MissingWordsReport { expected: number; recognized: number; matched: number; findings: MissingWordFinding[] }

/** Upper bound of words compared (the DP is expected × recognized). */
export const QA_MAX_WORDS = 2500;

/**
 * Compares the words she kept (the render's own word cues, output time) with what a fresh transcription of the render
 * heard: a longest-common-subsequence alignment on word keys (with small stem tolerance), then a pass that accepts an
 * expected word when the unmatched recognized words of the same gap contain it joined („Zwiebel schalen“). What stays
 * unmatched is grouped into runs. `cuts`: output times of cut points, clip boundaries, start and end. No auto-fix.
 */
export function missingWords(expected: readonly SubtitleCue[], recognized: readonly Pick<TranscriptWord, 'text'>[], opts: { cuts: readonly number[]; edgeSec?: number }): MissingWordsReport {
  const exp = expected.map((c) => ({ ...c, key: wordKey(c.text) })).filter((c) => c.key).slice(0, QA_MAX_WORDS);
  const rec = recognized.map((w) => wordKey(w.text)).filter(Boolean).slice(0, QA_MAX_WORDS);
  const n = exp.length, m = rec.length;
  // LCS table (n+1)×(m+1), row-major, as 16-bit lengths (≤ 2500 fits)
  const L = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      L[at(i, j)] = similar(exp[i]!.key, rec[j]!) ? L[at(i + 1, j + 1)]! + 1 : Math.max(L[at(i + 1, j)]!, L[at(i, j + 1)]!);
  const matched = new Array<boolean>(n).fill(false);
  const recUsed = new Array<boolean>(m).fill(false);
  /** The recognized index each matched expected word was aligned to. */
  const recOf = new Array<number>(n).fill(-1);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (similar(exp[i]!.key, rec[j]!) && L[at(i, j)] === L[at(i + 1, j + 1)]! + 1) { matched[i] = true; recUsed[j] = true; recOf[i] = j; i++; j++; }
    else if (L[at(i + 1, j)]! >= L[at(i, j + 1)]!) i++;
    else j++;
  }
  // second pass: an unmatched word that appears joined/split in the unmatched recognized words of its gap
  const aligned = [...recOf];
  for (let i = 0; i < n; i++) {
    if (matched[i]) continue;
    let lo = 0, hi = m;
    for (let k = i - 1; k >= 0; k--) if (aligned[k]! >= 0) { lo = aligned[k]! + 1; break; }
    for (let k = i + 1; k < n; k++) if (aligned[k]! >= 0) { hi = aligned[k]!; break; }
    const gap = [];
    for (let j = lo; j < hi; j++) if (!recUsed[j]) gap.push(rec[j]!);
    const joined = gap.join('');
    if (joined && (joined.includes(exp[i]!.key) || (exp[i]!.key.length >= 6 && exp[i]!.key.includes(joined)))) matched[i] = true;
  }
  const edge = opts.edgeSec ?? 0.25;
  const nearCut = (s: number, e: number) => opts.cuts.some((c) => c >= s - edge && c <= e + edge);
  const findings: MissingWordFinding[] = [];
  for (let i = 0; i < n; i++) {
    if (matched[i]) continue;
    const last = findings[findings.length - 1];
    const w = exp[i]!;
    const prevMissing = i > 0 && !matched[i - 1];
    if (last && prevMissing && w.startSec - last.endSec < 0.6) {
      Object.assign(last, { text: `${last.text} ${w.text}`, endSec: r3(Math.max(last.endSec, w.endSec)), words: last.words + 1, atCut: last.atCut || nearCut(w.startSec, w.endSec) });
    } else findings.push({ text: w.text, startSec: r3(w.startSec), endSec: r3(w.endSec), words: 1, atCut: nearCut(w.startSec, w.endSec) });
  }
  return { expected: n, recognized: m, matched: matched.filter(Boolean).length, findings };
}

/** Output times where something was cut or a clip changes, plus start and end (for `atCut`). */
export const cutPoints = (tl: Timeline): number[] =>
  [...new Set([0, ...tl.segments.flatMap((s) => [r3(s.outStart), r3(s.outEnd)]), r3(tl.durationSec)])].sort((a, b) => a - b);

// ---------- FFmpeg: the alpha layer ----------

/**
 * The text/graphics layer alone on a transparent 1080×1920/30p canvas (libass with `alpha=1`, which writes the alpha
 * channel; without it libass paints colours but leaves alpha at 0 – checked with FFmpeg 9), encoded as ProRes 4444 with
 * alpha (yuva444p10le). Paths are arguments; the subtitles path is refused when it holds quoting characters.
 */
export function buildAlphaLayer(assFile: string, durationSec: number, output: string, fontsDir?: string | null): string[] {
  const bad = /['\\:[\],;]/;
  if (bad.test(assFile.replace(/^[A-Za-z]:/, '')) || (fontsDir && bad.test(fontsDir.replace(/^[A-Za-z]:/, '')))) throw new Error('Pfad enthält unzulässige Zeichen');
  const d = Math.max(1 / 30, Math.round(durationSec * 1000) / 1000).toFixed(3);
  return [
    '-f', 'lavfi', '-i', `color=c=black@0:s=1080x1920:r=30:d=${d},format=rgba`,
    '-vf', `subtitles=filename='${assFile}'${fontsDir ? `:fontsdir='${fontsDir}'` : ''}:alpha=1`,
    '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-vendor', 'apl0', '-an', '-y', output,
  ];
}

export const FINISH_LABELS = { ai: AI_DISCLOSURE, ad: AD_DISCLOSURE } as const;
