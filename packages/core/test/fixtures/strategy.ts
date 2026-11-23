/** Invented, neutral strategy fixtures (no real person, place or employer). */
import raw from './strategy-import.json';
import type { ProfileAiSafe, ProfileLocalOnly, SensitiveTerm, StrategyLocalOnly } from '../../src/strategy';

/** The raw import object, including the unknown keys `evil` and `pillars[0].extra`. */
export const strategyImportFixture = raw;
export const strategyImportJson = JSON.stringify(raw, null, 2);

export const FIXTURE_SENSITIVE_TERMS: SensitiveTerm[] = [
  { term: 'Musterfirma GmbH', category: 'employer' },
  { term: 'Beispielstadt', category: 'home_location' },
];

const hex8 = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
};

/** Replaces every string leaf with `CANARY-LOCAL-<tag>-<n>-xxxxxxxx` (keys and the listed id fields stay). */
export function canaryFill<T>(value: T, tag: string, keep: ReadonlySet<string> = new Set(['pillarId', 'category'])): T {
  let n = 0;
  const walk = (v: unknown, key: string): unknown => {
    if (typeof v === 'string') {
      if (keep.has(key)) return v;
      n += 1;
      return `CANARY-LOCAL-${tag}-${n}-${hex8(`${tag}:${n}`)}`;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, '') as T;
}

/** A strategy local part whose every string leaf is a canary (one entry per list). */
export function canaryLocalOnly(tag: string): StrategyLocalOnly {
  return canaryFill<StrategyLocalOnly>({
    goal: { primary: 'x', secondary: ['x'], success6Months: 'x', success12Months: 'x' },
    positioning: { statement: 'x', core: 'x', differentiators: ['x'], notThis: ['x'] },
    audience: [{ name: 'x', situation: 'x', needs: ['x'], whatTheyGetFromYou: 'x' }],
    cadence: { postsPerWeek: 2, maxHoursPerWeek: null, notes: 'x' },
    boundaries: { showFace: 'x', showVoice: 'x', noGos: ['x', 'x'] },
    metrics: [{ goal: 'x', metric: 'x', reviewAfterWeeks: 8, decisionRule: 'x' }],
    openQuestions: ['x'],
    assumptions: ['x'],
    localExampleTopics: [{ pillarId: 'werkstatt', topic: 'x' }],
    sensitiveTerms: [{ term: 'x', category: 'custom' }],
    notes: 'x',
  }, tag);
}

/** A profile local part whose every string leaf is a canary. */
export function canaryProfileLocalOnly(tag: string): ProfileLocalOnly {
  return canaryFill<ProfileLocalOnly>({ notes: ['x', 'x'], topicIdeas: ['x'], sensitiveTerms: [{ term: 'x', category: 'custom' }] }, tag);
}

export const fixtureProfileAiSafe = (): ProfileAiSafe => ({
  who: 'Eine Person, die in ihrer Werkstatt Neues ausprobiert.',
  now: 'Baut gerade eine Routine für kurze Videos auf.',
  thread: 'Ausprobieren statt perfekt sein.',
  aiStance: 'KI hilft beim Strukturieren, die Ideen kommen von mir.',
  recurringThemes: ['Werkzeuge', 'kleine Fortschritte'],
  tone: 'ruhig, neugierig, ehrlich',
  boundariesGeneral: 'Nichts Privates über andere Menschen.',
});

/** An invented profile Markdown (Etappe 11). The line with „Lieblingswerkzeug“ is the former „local“ detail. */
export const PROFILE_MD = `# Profil

## Wer ich bin

Eine Person, die abends in ihrer Werkstatt Neues ausprobiert.

## Roter Faden

Ausprobieren statt perfekt sein.

## Notizen

- Lieblingswerkzeug: der alte Handhobel aus dem Keller
`;

/** An invented interview transcript, long enough to default to „nur Chat und Voice-Analyse“. */
export const INTERVIEW_MD = `# Interview: Werkstatt-Gespräch\n\n${Array.from({ length: 120 }, (_, i) => `**Frage ${i + 1}:** Was hast du heute ausprobiert?\n\nIch habe heute eine neue Verbindung geleimt und gelernt, dass Geduld hilft.`).join('\n\n')}\n`;

/** Strategy Markdown as a human-written original (attachment). */
export const STRATEGY_MD = '# Strategie v1\n\n## Ziel\n\nRegelmäßig kleine Videos fertigstellen.\n';
