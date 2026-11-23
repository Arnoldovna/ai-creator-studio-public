/**
 * UGC claim guard: a script may only state claims that appear in the allowlist
 * (verified brief facts + client-provided product claims). Everything else is moved
 * to `claimsToVerify` with a warning. Runs on every generated AND edited script.
 */
/** Claim matching ignores case, quotes and punctuation (paraphrases are NOT detected). */
export const normClaim = (s: string): string => s.toLowerCase().replace(/[„“"'.!?,;:]/g, '').replace(/\s+/g, ' ').trim();

export function enforceClaimAllowlist<T extends { verifiedClaims: string[]; claimsToVerify: string[]; warnings: string[] }>(
  script: T,
  allowlist: string[],
): T {
  const allowed = new Map(allowlist.map((c) => [normClaim(c), c]));
  const verified: string[] = [];
  const toVerify = new Set(script.claimsToVerify);
  for (const claim of script.verifiedClaims) {
    const hit = allowed.get(normClaim(claim));
    if (hit) verified.push(hit);
    else toVerify.add(claim);
  }
  const moved = [...toVerify].filter((c) => !script.claimsToVerify.includes(c));
  const warnings = [...script.warnings];
  if (moved.length) warnings.push(`${moved.length} Claim(s) sind nicht in den verifizierten Fakten und müssen vor der Aufnahme geprüft werden.`);
  return { ...script, verifiedClaims: [...new Set(verified)], claimsToVerify: [...toVerify], warnings: [...new Set(warnings)] };
}

interface ScriptTextParts {
  hookVariants: string[]; selectedHook: string; cta: string;
  scenes: { dialogue: string; onScreenText: string }[];
}

/** All user-facing text of a script (spoken + on screen), normalized for claim matching. */
export function scriptText(s: ScriptTextParts): string {
  return normClaim([...s.hookVariants, s.selectedHook, s.cta, ...s.scenes.flatMap((sc) => [sc.dialogue, sc.onScreenText])].join(' \n '));
}

/** Claims that literally (after normClaim) appear in any of the given texts. */
export function claimsInText(claims: Iterable<string>, ...texts: string[]): string[] {
  const text = normClaim(texts.join(' \n '));
  return [...new Set(claims)].filter((c) => {
    const n = normClaim(c);
    return n.length > 0 && text.includes(n);
  });
}

/** Flagged claims that still literally appear in the script text. */
export const claimsStillInText = (flagged: Iterable<string>, s: ScriptTextParts): string[] => claimsInText(flagged, scriptText(s));

/**
 * A flagged claim can only leave `claimsToVerify` when its text is gone from the script.
 * Paraphrases cannot be detected reliably – that is why approval additionally needs an
 * explicit human confirmation (see setScriptStatus).
 */
export function carryOverFlaggedClaims<T extends ScriptTextParts & { claimsToVerify: string[]; warnings: string[] }>(prevFlagged: string[], next: T): T {
  const kept = claimsStillInText(prevFlagged.filter((c) => !next.claimsToVerify.includes(c)), next);
  if (!kept.length) return next;
  return {
    ...next,
    claimsToVerify: [...next.claimsToVerify, ...kept],
    warnings: [...new Set([...next.warnings, `${kept.length} ungeprüfte(r) Claim(s) stehen noch im Text und bleiben markiert – erst aus Dialog/On-Screen-Text/Hooks/CTA entfernen.`])],
  };
}

/**
 * Single approval policy for scripts. Returns the reasons approval is blocked (empty = may approve):
 * open flagged claims, any claim ever flagged in the concept lineage that still stands in the text,
 * and the explicit human confirmation (paraphrased claims cannot be detected automatically).
 */
export function approvalBlockers(input: {
  script: ScriptTextParts & { claimsToVerify: string[] };
  lineageFlagged: string[];
  claimsReviewed: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.script.claimsToVerify.length)
    reasons.push('Es gibt noch ungeprüfte Claims. Entferne sie aus dem Text oder ergänze sie als verifizierte Fakten im Briefing.');
  const left = claimsStillInText(input.lineageFlagged, input.script);
  if (left.length) reasons.push(`Ungeprüfte Claims stehen noch im Text: ${left.join(' · ')}`);
  if (!input.claimsReviewed)
    reasons.push('Bestätigung fehlt, dass Dialog, On-Screen-Text, Hooks und CTA keine unbelegten Produktaussagen enthalten.');
  return reasons;
}
