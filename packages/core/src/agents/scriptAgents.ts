/**
 * Agents that work on an existing script version (Content Lab):
 * - Content QA (content_quality_assurance): rule checks + model findings; advisory, never edits the script.
 * - Instagram Copywriter (instagram_copywriting): caption, cover text, alt text for an APPROVED script; labels are enforced.
 * - Cinematic Director (cinematic_direction): beats, shotlist, optional AI asset briefs (text only, each needs approval).
 * Every runner returns `{ value, warnings }`.
 */
import { z } from 'zod';
import { claimsInText, normClaim } from '../claims';
import type { LlmProvider, StructuredResult } from '../providers/types';
import { SceneOrigin, ShotType, type UgcScript } from '../schemas';
import { collapseWs, squash, unique, wordCount } from '../text';
import { allowedClaims, untrustedCreativeContext, type CreativeContext } from './context';

export const CONTENT_QA_PROMPT_VERSION = 'content-qa@2026-11-15.2';
export const COPYWRITER_PROMPT_VERSION = 'instagram-copywriter@2026-11-15.2';
export const CINEMATIC_DIRECTOR_PROMPT_VERSION = 'cinematic-director@2026-11-15.2';

export type ScriptAgentResult<T> = StructuredResult<{ value: T; warnings: string[] }> & { promptVersion: string };

const clean = (s: string, max = 600) => collapseWs(s, max);
const sceneIndexOr = (i: number | null, script: UgcScript) => (i != null && Number.isInteger(i) && i >= 0 && i < script.scenes.length ? i : null);
/** Spoken + on-screen text per field (voice checks), and with visual directions (style checks, verbatim quotes). */
const spokenFields = (s: UgcScript) => [...s.hookVariants, s.selectedHook, s.cta, ...s.scenes.flatMap((sc) => [sc.dialogue, sc.onScreenText])];
const allFields = (s: UgcScript) => [...spokenFields(s), ...s.scenes.map((sc) => sc.visual)];
/** A quote is verbatim only if it occurs inside ONE field (no stitching across hook/CTA/scenes). */
const inSomeField = (fields: string[], q: string) => {
  const n = squash(q);
  return n.length >= 3 && fields.some((f) => squash(f).includes(n));
};

// ======================= Disclosures (one rule for QA, copy and approval) =======================
/** Label for generated or hybrid visuals. Never removed by any agent. */
export const AI_DISCLOSURE = 'KI-generierte Bildelemente';
/** Advertising label for paid client UGC (DE: "Anzeige"). */
export const AD_DISCLOSURE = 'Anzeige';

export interface StoryboardMedia { shots: { origin: string }[]; aiAssetBriefs: unknown[] }
export const storyboardHasAiMedia = (b: StoryboardMedia) => b.aiAssetBriefs.length > 0 || b.shots.some((x) => x.origin !== 'real');
export const scriptHasAiMedia = (s: UgcScript) => s.scenes.some((sc) => sc.origin !== 'real') || s.shotlist.some((x) => x.origin !== 'real');

/** Labels a publication of this script needs: ad label for client UGC, AI label if the script OR any storyboard plans AI media. */
export function requiredDisclosures(input: { projectKind: CreativeContext['projectKind']; script: UgcScript; storyboards?: StoryboardMedia[] }): string[] {
  const ai = scriptHasAiMedia(input.script) || (input.storyboards ?? []).some(storyboardHasAiMedia);
  return [...(input.projectKind === 'UGC_CLIENT' ? [AD_DISCLOSURE] : []), ...(ai ? [AI_DISCLOSURE] : [])];
}
/** Labels go first in the visible first line (before "… mehr"). */
export const disclosurePrefix = (labels: string[]) => (labels.length ? `${labels.join(' · ')} · ` : '');

/** Wording that would undercut a required label. */
export const AD_DENIAL = /\b(keine werbung|unbezahlt|nicht gesponsert|unsponsored|not sponsored|no ad)\b/i;
export const AI_DENIAL = /\b(ohne ki|keine ki|kein ki|100\s?% echt|unbearbeitet|no ai|not ai)\b/i;

// ======================= Content QA =======================
export const QaCategory = z.enum(['claim', 'style', 'voice', 'timing', 'disclosure', 'constraint', 'other']);
export const QaSeverity = z.enum(['blocker', 'warning', 'info']);
export const QaWire = z.object({
  summary: z.string(),
  findings: z.array(z.object({
    category: QaCategory,
    severity: QaSeverity,
    sceneIndex: z.number().nullable(),
    /** Verbatim excerpt from the script the finding refers to ('' if none). */
    quote: z.string(),
    issue: z.string(),
    suggestion: z.string(),
  })),
});
type QaWire = z.infer<typeof QaWire>;
export type QaFinding = Omit<QaWire['findings'][number], 'quote'> & { quote: string | null; source: 'rule' | 'model' };
export interface QaReport { summary: string; findings: QaFinding[]; blockers: number; warnings: number }

const WORDS_PER_SECOND_MAX = 3.0;

/** Deterministic checks – measured, not interpreted. Always part of the report, also with a real model. */
export function ruleQaFindings(script: UgcScript, ctx: CreativeContext): QaFinding[] {
  const f: QaFinding[] = [];
  const add = (x: Omit<QaFinding, 'source'>) => f.push({ ...x, source: 'rule' });
  if (!script.selectedHook.trim()) add({ category: 'constraint', severity: 'blocker', sceneIndex: null, quote: null, issue: 'Kein Hook ausgewählt.', suggestion: 'Einen Hook wählen.' });
  for (const c of script.claimsToVerify)
    add({ category: 'claim', severity: 'blocker', sceneIndex: null, quote: c, issue: 'Ungeprüfter Claim – nicht in den verifizierten Fakten bzw. Kundenclaims.', suggestion: 'Entfernen oder als verifizierten Fakt im Briefing belegen.' });
  script.scenes.forEach((sc, i) => {
    const dur = sc.endSecond - sc.startSecond, n = wordCount(sc.dialogue);
    if (n && dur <= 0) add({ category: 'timing', severity: 'warning', sceneIndex: i, quote: null, issue: `${n} Wörter in einer Szene ohne Dauer.`, suggestion: 'Szenenzeiten korrigieren.' });
    else if (dur > 0 && n / dur > WORDS_PER_SECOND_MAX)
      add({ category: 'timing', severity: 'warning', sceneIndex: i, quote: null, issue: `${n} Wörter in ${dur}s (${(n / dur).toFixed(1)} Wörter/s) – kaum natürlich sprechbar.`, suggestion: 'Kürzen oder Szene verlängern (Ziel ca. 2,3 Wörter/s).' });
  });
  if (Math.abs(script.estimatedSeconds - ctx.brief.lengthSeconds) > Math.max(3, ctx.brief.lengthSeconds * 0.15))
    add({ category: 'timing', severity: 'warning', sceneIndex: null, quote: null, issue: `Skriptlänge ${script.estimatedSeconds}s statt Ziel ${ctx.brief.lengthSeconds}s.`, suggestion: 'Szenen an die Ziellänge anpassen.' });
  const avoidHits = (items: string[], fields: string[], category: 'voice' | 'style', label: string) => {
    for (const a of items)
      if (inSomeField(fields, a)) add({ category, severity: 'warning', sceneIndex: null, quote: a, issue: `Steht auf der Vermeiden-Liste des ${label}.`, suggestion: 'Umformulieren oder streichen.' });
  };
  avoidHits(ctx.voice?.rules.avoid ?? [], spokenFields(script), 'voice', 'Voice Guides'); // voice = what is said, not stage directions
  avoidHits(ctx.style?.rules.visual.avoid ?? [], allFields(script), 'style', 'Style Bible');
  for (const label of requiredDisclosures({ projectKind: ctx.projectKind, script }))
    add({
      category: 'disclosure', severity: 'info', sceneIndex: null, quote: null,
      issue: label === AD_DISCLOSURE ? 'Bezahlte Kundenkooperation.' : 'Das Skript enthält KI-generierte oder hybride Bildelemente.',
      suggestion: `Bei Veröffentlichung kennzeichnen („${label}“, plus Instagram-Kennzeichnung) und offenlegen, nicht verstecken.`,
    });
  if (!ctx.voice) add({ category: 'voice', severity: 'info', sceneIndex: null, quote: null, issue: 'Kein Voice Guide – Voice-Treue nicht prüfbar.', suggestion: 'Voice Guide anlegen und freigeben.' });
  if (!ctx.style) add({ category: 'style', severity: 'info', sceneIndex: null, quote: null, issue: 'Keine Style Bible – Style-Treue nicht prüfbar.', suggestion: 'Style Bible anlegen und freigeben.' });
  return f;
}

/** Rule findings first, then model findings; a model quote that is not verbatim in one script field is dropped. */
export function buildQaReport(raw: unknown, script: UgcScript, ctx: CreativeContext): { value: QaReport; warnings: string[] } {
  const w = QaWire.parse(raw);
  const fields = allFields(script);
  let dropped = 0;
  const model: QaFinding[] = w.findings
    .filter((x) => x.issue.trim())
    .slice(0, 25)
    .map((x) => {
      const verbatim = inSomeField(fields, x.quote);
      if (x.quote.trim() && !verbatim) dropped++;
      return {
        category: x.category, severity: x.severity, sceneIndex: sceneIndexOr(x.sceneIndex, script),
        quote: verbatim ? clean(x.quote, 300) : null, issue: clean(x.issue), suggestion: clean(x.suggestion), source: 'model' as const,
      };
    });
  const findings = [...ruleQaFindings(script, ctx), ...model];
  return {
    value: {
      summary: clean(w.summary, 1000),
      findings,
      blockers: findings.filter((x) => x.severity === 'blocker').length,
      warnings: findings.filter((x) => x.severity === 'warning').length,
    },
    warnings: dropped ? [`${dropped} Zitat(e) der KI standen nicht im Skript und wurden entfernt.`] : [],
  };
}

const QA_SYSTEM = `Du bist Content-QA für Instagram-Reels und UGC. Prüfe das Skript gegen die verifizierten Claims,
die Style Bible, den Voice Guide und das Briefing. Du änderst nichts, du meldest Befunde.
Regeln:
- "blocker" nur für unbelegte Produkt-/Wirkungsaussagen, erfundene Erfahrungen/Testimonials/Zahlen oder fehlende Kennzeichnung.
- "warning" für Stil-, Voice- und Sprechbarkeitsprobleme; "info" für Hinweise.
- "quote": wörtlicher Ausschnitt aus GENAU EINEM Feld des Skripts, sonst leer. sceneIndex = Index in scenes (0-basiert) oder null.
- Keine Befunde erfinden, nur was im Skript steht. Regelprüfungen (Timing, Vermeiden-Listen) laufen separat.
Antworte auf Deutsch.`;

export async function runContentQa(provider: LlmProvider, ctx: CreativeContext, script: UgcScript): Promise<ScriptAgentResult<QaReport>> {
  const res = await provider.generate({
    agent: 'content_qa',
    promptVersion: CONTENT_QA_PROMPT_VERSION,
    schemaName: 'content_qa',
    schema: QaWire,
    system: QA_SYSTEM,
    instruction: 'Prüfe das Skript (script) auf Claims, Style-Treue, Voice-Treue, Sprechbarkeit und Kennzeichnung. Max. 15 Befunde, wichtigste zuerst, plus eine Zusammenfassung in 1–2 Sätzen.',
    untrustedContext: { ...untrustedCreativeContext(ctx), script, allowedClaims: allowedClaims(ctx) },
    mock: () => ({ summary: '[MOCK] Nur Regelprüfungen (Claims, Timing, Vermeiden-Listen, Kennzeichnung) – keine KI-Prüfung von Stil und Tonalität.', findings: [] }),
  });
  return { ...res, output: buildQaReport(res.output, script, ctx), promptVersion: CONTENT_QA_PROMPT_VERSION };
}

// ======================= Instagram Copywriter =======================
export const CopyWire = z.object({
  /** A = the reel carries the hook, line one is the ask/context; B = the caption is the hook. */
  job: z.enum(['A', 'B']),
  firstLine: z.string(),
  body: z.array(z.string()),
  ask: z.string(),
  searchTerms: z.array(z.string()),
  hashtags: z.array(z.string()),
  coverText: z.string(),
  altText: z.string(),
  /** Every product/effect statement used in caption, cover or alt text – checked against the allowlist. */
  claimsUsed: z.array(z.string()),
});
type CopyWire = z.infer<typeof CopyWire>;
export interface CaptionLint { level: 'fail' | 'warn'; message: string }
export interface InstagramCopy extends CopyWire {
  /** Labels the studio set at creation (re-checked against the current rules on approval). */
  disclosures: string[];
  /** Copy-ready caption as it would be pasted. */
  caption: string;
  lint: CaptionLint[];
}
/** What the caption is checked against – always computed from the CURRENT project, script, storyboards and claims. */
export interface CaptionRules { required: string[]; allowed: string[]; flagged: string[] }

export const CAPTION_MAX = 2200;
export const VISIBLE_CHARS = 125;
export const HASHTAG_MAX = 5;
const GENERIC_HASHTAGS = new Set(['#viral', '#fyp', '#foryou', '#foryoupage', '#explorepage', '#explore', '#reels', '#trending', '#instagood']);
export const URL_RE = /\b(?:https?:\/\/|www\.)\S+/i;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
export const NUMBER_RE = /\d+(?:[.,]\d+)?\s?%?/g;

/** Lint after the ig-caption rules plus the studio's gates: labels present and not denied, claims only from the allowlist. */
export function lintCaption(copy: Pick<InstagramCopy, 'caption' | 'coverText' | 'altText' | 'ask' | 'hashtags' | 'claimsUsed'>, rules: CaptionRules): CaptionLint[] {
  const out: CaptionLint[] = [];
  const fail = (message: string) => out.push({ level: 'fail', message });
  const warn = (message: string) => out.push({ level: 'warn', message });
  const published = [copy.caption, copy.coverText, copy.altText].join('\n');
  const prefix = disclosurePrefix(rules.required);
  if (!copy.caption.startsWith(prefix)) fail(`Kennzeichnung fehlt am Anfang der ersten Zeile: „${prefix.trim()}“.`);
  if (rules.required.includes(AD_DISCLOSURE) && AD_DENIAL.test(published)) fail('Text bestreitet die Werbekennzeichnung (z. B. „keine Werbung“).');
  if (rules.required.includes(AI_DISCLOSURE) && AI_DENIAL.test(published)) fail('Text bestreitet die KI-Kennzeichnung (z. B. „ohne KI“, „100 % echt“).');
  const first = copy.caption.split('\n')[0] ?? '';
  if (first.length > VISIBLE_CHARS) warn(`Erste Zeile hat ${first.length} Zeichen – nur ${VISIBLE_CHARS} sind vor „… mehr“ sichtbar.`);
  const afterLabels = first.slice(prefix.length);
  if (/^(#|hallo\b|hi\b|hey\b)/i.test(afterLabels) || /^\p{Extended_Pictographic}/u.test(afterLabels)) warn('Erste Zeile beginnt mit Gruß, Hashtag oder Emoji.');
  if (copy.caption.length > CAPTION_MAX) fail(`Caption hat ${copy.caption.length} Zeichen (max. ${CAPTION_MAX}).`);
  if (copy.hashtags.length > HASHTAG_MAX) fail(`${copy.hashtags.length} Hashtags (max. ${HASHTAG_MAX}).`);
  if (URL_RE.test(published)) fail('Link in Caption/Cover/Alt-Text – Captions sind nicht klickbar (Bio oder DM).');
  if (!copy.ask.trim()) warn('Keine Handlungsaufforderung (ask).');
  const emoji = (copy.caption.match(EMOJI_RE) ?? []).length;
  if (copy.caption.length && emoji / copy.caption.length > 0.04) warn(`${emoji} Emoji – mehr als 4 pro 100 Zeichen.`);
  const flaggedLeft = claimsInText(rules.flagged, published);
  if (flaggedLeft.length) fail(`Ungeprüfte Claims im Text: ${flaggedLeft.join(' · ')}`);
  const allowed = new Set(rules.allowed.map(normClaim));
  const unverified = copy.claimsUsed.filter((c) => normClaim(c) && !allowed.has(normClaim(c)));
  if (unverified.length) fail(`Aussagen ohne verifizierten Claim: ${unverified.join(' · ')}`);
  // Numbers are the most common invented "results" – any figure that is not in a verified claim needs a look.
  const allowedText = normClaim(rules.allowed.join(' '));
  const numbers = unique((published.match(NUMBER_RE) ?? []).map((n) => normClaim(n))).filter((n) => !allowedText.includes(n));
  if (numbers.length) warn(`Zahlen ohne verifizierten Claim: ${numbers.join(', ')} – nur echte, belegte Werte verwenden.`);
  return out;
}

/** Normalizes model output, puts the required labels first and assembles the caption. */
export function buildInstagramCopy(raw: unknown, rules: CaptionRules): { value: InstagramCopy; warnings: string[] } {
  const c: CopyWire = CopyWire.parse(raw);
  const warnings: string[] = [];
  const tags = unique(c.hashtags.map((h) => `#${h.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')}`.toLowerCase()).filter((h) => h.length > 1));
  const generic = tags.filter((h) => GENERIC_HASHTAGS.has(h));
  if (generic.length) warnings.push(`Generische Hashtags entfernt: ${generic.join(' ')}`);
  const hashtags = tags.filter((h) => !GENERIC_HASHTAGS.has(h));
  const firstLine = clean(c.firstLine, 300), body = c.body.map((p) => clean(p, 800)).filter(Boolean).slice(0, 6), ask = clean(c.ask, 300);
  const caption = [disclosurePrefix(rules.required) + firstLine, ...body, ask, hashtags.join(' ')].filter(Boolean).join('\n\n');
  const copy = {
    job: c.job, firstLine, body, ask, hashtags, caption,
    searchTerms: unique(c.searchTerms.map((t) => clean(t, 80))).slice(0, 5),
    coverText: clean(c.coverText, 120), altText: clean(c.altText, 500),
    claimsUsed: unique(c.claimsUsed.map((x) => clean(x, 300))),
    disclosures: rules.required,
  };
  return { value: { ...copy, lint: lintCaption(copy, rules) }, warnings };
}

export function mockInstagramCopy(script: UgcScript, ctx: CreativeContext): CopyWire {
  const topic = ctx.brief.topic;
  const fact = allowedClaims(ctx)[0];
  return {
    job: 'A',
    firstLine: script.cta || `Was würdest du bei ${topic} als Nächstes ausprobieren?`,
    body: [`[MOCK] Kontext zum Video über ${topic}.`, ...(fact ? [fact] : [])],
    ask: 'Schreib mir deine Frage in die Kommentare.',
    searchTerms: [topic],
    hashtags: [topic.split(/\s+/).at(-1) ?? 'creator'],
    coverText: script.selectedHook.slice(0, 60),
    altText: `Vertikales Video: ${script.scenes.map((s) => s.visual).slice(0, 2).join('; ')}`,
    claimsUsed: fact ? [fact] : [],
  };
}

const COPY_SYSTEM = `Du bist Instagram-Copywriterin für ein freigegebenes Reel-Skript. Schreibe Caption, Cover-Text und Alt-Text
in der Stimme der Creatorin (Voice Guide).
Regeln (ig-caption):
- Entscheide job: "A" wenn das Reel den Hook trägt (dann ist die erste Zeile die Bitte/der Kontext), "B" wenn die Caption der Hook ist.
- Erste Zeile max. ca. 100 Zeichen (das Studio setzt Pflicht-Kennzeichnungen davor), kein Gruß, kein Hashtag, kein Emoji am Anfang.
- body: 2–6 kurze Absätze; Suchbegriffe als normale Wörter im Text. Keine Links.
- ask: genau EINE Handlungsaufforderung.
- hashtags: max. 3 spezifische Themen-Labels, keine generischen (#viral, #fyp …).
- Produkt- oder Wirkungsaussagen NUR wörtlich aus allowedClaims; jede verwendete Aussage zusätzlich in claimsUsed eintragen.
  Keine erfundenen Ergebnisse, Zahlen, Testimonials oder persönlichen Erfahrungen.
- Kennzeichnungen (Anzeige, KI-generiert) setzt das Studio; schreibe nichts, was sie abschwächt („keine Werbung“, „ohne KI“, „100 % echt“).
Antworte auf Deutsch.`;

export async function runInstagramCopywriter(provider: LlmProvider, ctx: CreativeContext, script: UgcScript, rules: CaptionRules): Promise<ScriptAgentResult<InstagramCopy>> {
  const res = await provider.generate({
    agent: 'instagram_copywriter',
    promptVersion: COPYWRITER_PROMPT_VERSION,
    schemaName: 'instagram_copy',
    schema: CopyWire,
    system: COPY_SYSTEM,
    instruction: 'Schreibe die Caption (erste Zeile, Absätze, eine Bitte, Suchbegriffe, Hashtags), einen Cover-Text (max. 6 Wörter) und einen Alt-Text für das Skript (script); liste verwendete Claims in claimsUsed.',
    untrustedContext: { ...untrustedCreativeContext(ctx), script, allowedClaims: rules.allowed, requiredLabels: rules.required },
    mock: () => mockInstagramCopy(script, ctx),
  });
  return { ...res, output: buildInstagramCopy(res.output, rules), promptVersion: COPYWRITER_PROMPT_VERSION };
}

// ======================= Cinematic Director =======================
export const StoryboardWire = z.object({
  logline: z.string(),
  beats: z.array(z.object({ sceneIndex: z.number(), intent: z.string(), camera: z.string(), lighting: z.string(), sound: z.string(), transition: z.string() })),
  shots: z.array(z.object({ sceneIndex: z.number(), shot: z.string(), shotType: ShotType, framing: z.string(), movement: z.string(), notes: z.string(), origin: SceneOrigin })),
  aiAssetBriefs: z.array(z.object({ sceneIndex: z.number(), purpose: z.string(), prompt: z.string() })),
  production: z.object({ estimatedShootMinutes: z.number(), locations: z.array(z.string()), props: z.array(z.string()) }),
  warnings: z.array(z.string()),
});
type StoryboardWire = z.infer<typeof StoryboardWire>;
export interface Storyboard extends Omit<StoryboardWire, 'aiAssetBriefs'> {
  /** Text briefs only. Nothing is generated or bought; each one needs explicit approval and carries the AI label. */
  aiAssetBriefs: (StoryboardWire['aiAssetBriefs'][number] & { disclosureLabel: string; requiresApproval: true; clientApprovalRequired: boolean })[];
}

const ORIGIN_RANK = { real: 0, hybrid: 1, generated: 2 } as const;
const IMITATION = /\b(im stil von|in the style of|wie @|like @)|@\w+/i;

export function buildStoryboard(raw: unknown, script: UgcScript, ctx: CreativeContext): { value: Storyboard; warnings: string[] } {
  const s = StoryboardWire.parse(raw);
  const warnings: string[] = [];
  const valid = (i: number) => sceneIndexOr(i, script) != null;
  let forcedReal = 0;
  const shots = s.shots.filter((x) => valid(x.sceneIndex) && x.shot.trim()).slice(0, 40).map((x) => {
    const scene = script.scenes[x.sceneIndex]!;
    // A shot is never "more real" than its scene; product shots are always real footage (never AI product proof).
    let origin = ORIGIN_RANK[x.origin] < ORIGIN_RANK[scene.origin] ? scene.origin : x.origin;
    if ((x.shotType === 'product' || scene.shotType === 'product') && origin !== 'real') { origin = 'real'; forcedReal++; }
    return { ...x, origin, shot: clean(x.shot, 300), framing: clean(x.framing, 120), movement: clean(x.movement, 160), notes: clean(x.notes, 300) };
  });
  if (forcedReal) warnings.push(`${forcedReal} Produkt-Einstellung(en) auf echte Aufnahme gesetzt – Produkte werden nie KI-generiert gezeigt.`);
  const productScene = (i: number) => script.scenes[i]!.shotType === 'product' || shots.some((x) => x.sceneIndex === i && x.shotType === 'product');
  const rawBriefs = s.aiAssetBriefs.filter((b) => valid(b.sceneIndex) && b.prompt.trim()).slice(0, 10);
  const briefs = rawBriefs.filter((b) => !productScene(b.sceneIndex));
  if (briefs.length < rawBriefs.length) warnings.push(`${rawBriefs.length - briefs.length} KI-Brief(s) für Produktszenen entfernt.`);
  if (briefs.some((b) => IMITATION.test(`${b.purpose} ${b.prompt}`))) warnings.push('Ein KI-Brief nennt einen Creator/Account oder „im Stil von“ – eigene Bildsprache statt Imitation verwenden.');
  const ugc = ctx.projectKind === 'UGC_CLIENT';
  if (ugc && briefs.length) warnings.push('Kundenprojekt: KI-Assets nur als klar erkennbare Atmosphäre und nur mit dokumentierter Zustimmung der Kundin.');
  const unbriefed = shots.filter((x) => x.origin !== 'real' && !briefs.some((b) => b.sceneIndex === x.sceneIndex));
  if (unbriefed.length) warnings.push(`${unbriefed.length} KI-/Hybrid-Einstellung(en) ohne Asset-Brief – vor der Produktion ergänzen oder real drehen.`);
  return {
    value: {
      logline: clean(s.logline, 300),
      beats: s.beats.filter((b) => valid(b.sceneIndex)).slice(0, 20).map((b) => ({ ...b, intent: clean(b.intent, 300), camera: clean(b.camera, 200), lighting: clean(b.lighting, 200), sound: clean(b.sound, 200), transition: clean(b.transition, 120) })),
      shots,
      aiAssetBriefs: briefs.map((b) => ({ ...b, purpose: clean(b.purpose, 300), prompt: clean(b.prompt, 1200), disclosureLabel: AI_DISCLOSURE, requiresApproval: true as const, clientApprovalRequired: ugc })),
      production: {
        estimatedShootMinutes: Number.isFinite(s.production.estimatedShootMinutes) ? Math.max(0, Math.round(s.production.estimatedShootMinutes)) : 0,
        locations: unique(s.production.locations.map((x) => clean(x, 120))).slice(0, 10),
        props: unique(s.production.props.map((x) => clean(x, 120))).slice(0, 20),
      },
      warnings: s.warnings.map((x) => clean(x)).filter(Boolean).slice(0, 10),
    },
    warnings,
  };
}

export function mockStoryboard(script: UgcScript, ctx: CreativeContext): StoryboardWire {
  const style = ctx.style?.rules;
  return {
    logline: `[MOCK] ${script.selectedHook}`,
    beats: script.scenes.map((sc, i) => ({
      sceneIndex: i, intent: sc.beat, camera: sc.shotType === 'talking_head' ? 'Augenhöhe, statisch' : 'Handkamera, ruhig',
      lighting: style?.visual.lighting || 'natürliches Fensterlicht', sound: sc.dialogue ? 'O-Ton' : 'Atmo',
      transition: i < script.scenes.length - 1 ? (style?.motion.transitions[0] ?? 'harter Cut') : 'Ende',
    })),
    shots: script.scenes.map((sc, i) => ({ sceneIndex: i, shot: sc.visual, shotType: sc.shotType, framing: '9:16 vertikal', movement: 'statisch', notes: 'Mehrere Takes, je 3–5 s', origin: sc.origin })),
    aiAssetBriefs: [],
    production: { estimatedShootMinutes: script.scenes.length * 10, locations: ['Arbeitsplatz'], props: [] },
    warnings: ['[MOCK] Regelbasiert aus den Skriptszenen abgeleitet – keine dramaturgische KI-Planung.'],
  };
}

const CINEMATIC_SYSTEM = `Du bist Cinematic Director für vertikale Reels und UGC. Plane aus dem Skript Beats, eine drehbare Shotlist
und – nur wo sinnvoll – Briefs für optionale KI-Assets.
Regeln:
- Echte Aufnahmen zuerst ("real"). "generated"/"hybrid" nur für klar künstlerische Atmosphäre, nie für Produkte, Ergebnisse oder Belege.
- Jede generated/hybrid-Einstellung braucht einen aiAssetBrief mit Zweck und Prompt. Es wird nichts erzeugt oder gekauft.
- Halte dich an die Style Bible (Licht, Komposition, Übergänge, Vermeiden-Liste). Keine Creator-Namen, Accounts oder „im Stil von“.
- sceneIndex = Index in script.scenes (0-basiert). Realistische Drehzeit in Minuten.
Antworte auf Deutsch.`;

export async function runCinematicDirector(provider: LlmProvider, ctx: CreativeContext, script: UgcScript): Promise<ScriptAgentResult<Storyboard>> {
  const res = await provider.generate({
    agent: 'cinematic_director',
    promptVersion: CINEMATIC_DIRECTOR_PROMPT_VERSION,
    schemaName: 'storyboard',
    schema: StoryboardWire,
    system: CINEMATIC_SYSTEM,
    instruction: 'Erstelle Logline, einen Beat pro Szene, eine Shotlist (1–3 Einstellungen je Szene), optionale KI-Asset-Briefs und Produktionsnotizen für das Skript (script).',
    untrustedContext: { ...untrustedCreativeContext(ctx), script },
    mock: () => mockStoryboard(script, ctx),
  });
  return { ...res, output: buildStoryboard(res.output, script, ctx), promptVersion: CINEMATIC_DIRECTOR_PROMPT_VERSION };
}
