// Med → indication (condition) link — the tier-2 text matcher (issue #1052). PURE —
// no DB, no network. Tier-1 (the deterministic FHIR reasonReference resolution) lives
// in lib/fhir/resources.ts (reasonConditionExternalId) and is applied at persist; this
// file is the tier-2 SUGGEST-AND-ACCEPT half: a med's imported indication TEXT
// (reasonCode note / course note / the med's own free-text) EXACT-matching a recorded
// condition's name or code PROPOSES a link the user accepts — never a fuzzy silent
// link, never a name-overlap auto-link ("metformin" + a diabetes condition never links
// silently; only the imported REASON text does).

export interface ConditionRef {
  id: number;
  name: string;
  code: string | null;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

// Does the indication text contain the condition name as a WHOLE phrase (word-
// bounded), so "for ear infection" matches the "Ear infection" condition but
// "metformin" never spuriously matches "Formin syndrome". Exact whole-string equality
// also counts.
function textNamesCondition(text: string, name: string): boolean {
  const t = norm(text);
  const n = norm(name);
  if (!n) return false;
  if (t === n) return true;
  // Word-bounded phrase containment.
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, "i").test(t);
}

// Suggest the ONE condition a med's indication text names, or null. Matches a
// condition when the text word-bound-contains its name OR exactly equals its code.
// Returns null when nothing matches OR when the text names TWO+ DISTINCT conditions
// (ambiguous → no silent guess, the #534/#482 exclusion discipline). Proposes, never
// links — the caller persists only on an explicit accept.
export function suggestIndicationFromText(
  text: string | null | undefined,
  conditions: readonly ConditionRef[]
): ConditionRef | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const codeNorm = norm(t);
  const matches: ConditionRef[] = [];
  for (const c of conditions) {
    const byName = textNamesCondition(t, c.name);
    const byCode = !!c.code && norm(c.code) === codeNorm;
    if (byName || byCode) matches.push(c);
  }
  // Collapse matches that are the SAME condition id, then require a single distinct
  // condition (ambiguity ⇒ no suggestion).
  const distinct = new Map<number, ConditionRef>();
  for (const m of matches) distinct.set(m.id, m);
  return distinct.size === 1 ? [...distinct.values()][0] : null;
}
