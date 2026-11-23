import { HEX, STYLE_ITEM_MAX, STYLE_TEXT_MAX, ValidationError, type StyleBibleRules, type StyleForm, type VoiceForm, type VoiceGuideRules } from '../schemas';
import { splitList, unique } from '../text';

export interface StyleComposeInput {
  /** `palette` is an optional manual override (#RRGGBB list). */
  form: Omit<StyleForm, 'palette'> & { palette?: string };
  references: { id: string; palette: string[]; likes: string[]; dislikes: string[] }[];
  /** Only observations the user explicitly approved. */
  approvedObservations: { id: string; referenceId: string; dimension: string; statement: string; colors?: string[] }[];
}

const LABELS: Record<string, string> = {
  traits: 'Merkmale', avoid: 'Vermeiden', transitions: 'Übergänge', typography: 'Typografie', lighting: 'Licht',
  composition: 'Komposition', textures: 'Texturen', motion: 'Tempo',
};

export const DEFAULT_STYLE_NAME = 'My Creator Style';

/** Clear 400 instead of an opaque schema error when a user entry exceeds the Style Bible limits. */
function assertItems(field: string, items: string[], max = STYLE_ITEM_MAX) {
  const tooLong = items.find((i) => i.length > max);
  if (tooLong)
    throw new ValidationError(`${LABELS[field] ?? field}: Eintrag „${tooLong.slice(0, 40)}…“ ist ${tooLong.length} Zeichen lang (max. ${max}). Mehrere Punkte bitte mit Komma oder Zeilenumbruch trennen.`);
}
function assertText(field: string, text: string, max = STYLE_TEXT_MAX) {
  if (text.trim().length > max) throw new ValidationError(`${LABELS[field] ?? field}: max. ${max} Zeichen (aktuell ${text.trim().length}).`);
}

/** Palette suggestion from liked references + approved observation colours (shown in the editor, used when no manual palette is set). */
export function suggestPalette(references: StyleComposeInput['references'], approvedObservations: StyleComposeInput['approvedObservations']): string[] {
  return unique([...references.filter((r) => r.likes.length).flatMap((r) => r.palette), ...approvedObservations.flatMap((o) => o.colors ?? [])]).slice(0, 8);
}

/**
 * Deterministic composition of a Style Bible draft (prototype logic + approved AI observations).
 * Nothing pending or rejected is ever included — the human gate is enforced here.
 */
export function composeStyleBible(input: StyleComposeInput): StyleBibleRules {
  const liked = input.references.filter((r) => r.likes.length);
  const manual = splitList(input.form.palette ?? '', 12).map((c) => c.toUpperCase()).filter((c) => HEX.test(c));
  const palette = manual.length ? unique(manual) : suggestPalette(input.references, input.approvedObservations);
  const formTraits = splitList(input.form.traits), formAvoid = splitList(input.form.avoid), transitions = splitList(input.form.transitions, 20);
  assertItems('traits', formTraits);
  assertItems('avoid', formAvoid);
  assertItems('transitions', transitions);
  for (const f of ['typography', 'lighting', 'composition', 'textures', 'motion'] as const) assertText(f, input.form[f]);
  const refLikes = liked.flatMap((r) => r.likes).filter((l) => l.length <= STYLE_ITEM_MAX);
  const refDislikes = input.references.flatMap((r) => r.dislikes).filter((l) => l.length <= STYLE_ITEM_MAX);
  const obsTraits = input.approvedObservations.filter((o) => o.dimension !== 'color').map((o) => o.statement.slice(0, STYLE_ITEM_MAX));
  return {
    name: input.form.name.trim() || DEFAULT_STYLE_NAME,
    visual: {
      palette,
      traits: unique([...formTraits, ...refLikes, ...obsTraits]).slice(0, 40),
      avoid: unique([...formAvoid, ...refDislikes]).slice(0, 40),
      typography: input.form.typography.trim(),
      lighting: input.form.lighting.trim(),
      composition: input.form.composition.trim(),
      textures: input.form.textures.trim(),
    },
    motion: { pacing: input.form.motion.trim(), transitions },
    approvedReferenceIds: unique([...liked.map((r) => r.id), ...input.approvedObservations.map((o) => o.referenceId)]),
    approvedObservationIds: input.approvedObservations.map((o) => o.id),
  };
}

export function composeVoiceGuide(form: VoiceForm, existing?: VoiceGuideRules | null): VoiceGuideRules {
  const ex = form.example.trim();
  const traits = splitList(form.traits, 30), avoid = splitList(form.avoid, 30);
  assertItems('traits', traits);
  assertItems('avoid', avoid);
  if (ex.length > 2000) throw new ValidationError('Beispieltext: max. 2000 Zeichen.');
  return {
    traits,
    avoid,
    ownExamples: unique([...(ex ? [ex] : []), ...(existing?.ownExamples ?? [])]).slice(0, 20),
  };
}
