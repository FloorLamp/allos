// THE LEAD + FOLD CENSUS RULE (#3488, #3490; copy.md rule 10).
//
// One question — "is this intro a lead, or is it a wall?" — written once, so the
// pure guard over the integrations registry
// (lib/__tests__/lead-fold-census.test.ts) and the probe that measures RENDERED
// intros at 390px (e2e/lead-fold-census.mobile.spec.ts) are the same rule rather
// than two that can drift.
//
// ── THE TWO HALVES ANSWER DIFFERENT QUESTIONS, ON PURPOSE ───────────────────────
//
// A character budget is a PROXY for lines; the box on the phone is the thing the
// reader actually meets. #3529 wrote this down for geometry and it applies here
// verbatim: a computed style measures a DECLARATION and the user sees a RENDERED
// result. So the numbers below gate the SOURCE (a registry entry cannot ship a
// paragraph in its `lead` field), and the e2e probe measures `getBoundingClientRect`
// on the real paragraph in a real 390px viewport. Neither substitutes for the other:
// the source rule cannot see a lead that wraps to four lines because its container
// got narrower, and the probe cannot see a wall on a route it does not visit.
//
// ── AND BOTH ARE ABSENCE ASSERTIONS, SO BOTH CARRY A FLOOR ──────────────────────
//
// "No lead exceeds N characters" goes green the moment the scan stops finding
// leads — a renamed field, a moved registry, an intro that stopped rendering. The
// pure guard therefore asserts the registry's SIZE against `EXPECTED_REGISTRY_SIZE`
// below, and the probe carries a per-route floor plus a synthetic offender planted
// in the live DOM. #3509 is the standing issue for this class.

/**
 * THE TWO-LINE BUDGET, IN CHARACTERS, and where the number comes from.
 *
 * Stating the unit is the check, not bookkeeping (#3391). This bounds the LEAD
 * STRING's length in characters — not words, not rendered pixels.
 *
 * Derivation. At 390px the narrowest host for a lead is the Import card: 390 − 32
 * (page gutter) − 32 (the card's `p-4` below `sm`) = 326px of text column. The
 * leads render at `text-sm` (14px), whose average advance in the app's sans stack
 * is ~6.5px, so a line holds ~50 characters. Two lines is ~100. The integration
 * pages are wider (`width="reading"` with no card, ~358px), so the card is the
 * binding constraint and one number covers both.
 *
 * It is a CEILING on a proxy, deliberately generous: a lead at 100 characters that
 * happens to wrap to three lines is caught by the e2e probe, which measures the
 * box. What this number stops is the 146-word paragraph — the defect that was
 * actually shipped — reappearing in a field renamed `lead`.
 */
export const LEAD_MAX_CHARS = 100;

/**
 * The registry's size, asserted so this census cannot go green by finding nothing.
 *
 * NOT a maximum and not a design opinion: it is the count at the moment the rule
 * was written (2026-08-22), recorded so that a registry which lost entries — or a
 * scan pointed at the wrong export — fails instead of passing vacuously. Adding an
 * integration is expected and the fix is to raise this number in the same change
 * that adds the entry.
 */
export const EXPECTED_REGISTRY_SIZE = 9;

/**
 * Sentence terminators that end a lead. `.`, `?`, `!` followed by whitespace or
 * end-of-string.
 *
 * It deliberately does NOT count the period inside "Lose It!", "e.g." or a
 * decimal, because those are not followed by whitespace-then-capital in the shapes
 * this repo writes — and a sentence counter that cries wolf on a product name gets
 * deleted within a week, taking the real rule with it (#3325).
 */
const SENTENCE_END_RE = /[.!?](?=\s|$)/g;

/** How many sentences a lead is made of. A fragment with no terminator counts as 1. */
export function sentenceCount(text: string): number {
  const n = (text.trim().match(SENTENCE_END_RE) ?? []).length;
  return n === 0 ? 1 : n;
}

export interface LeadDefect {
  kind: "too-long" | "too-many-sentences" | "empty";
  detail: string;
}

/**
 * Everything wrong with one lead. Empty array = clean.
 *
 * `maxSentences` is a parameter rather than a constant because the two adopters
 * were ruled at different numbers and both rulings are in writing: #3490 requires
 * every REGISTRY lead to be exactly one sentence, while #3488 specifies the Import
 * card's lead verbatim as two short ones ("… we'll read it for you. Several files
 * at once is fine."). Hardcoding either would make this rule disagree with an
 * owner ruling, so the caller states which ruling it is enforcing.
 */
export function leadDefects(
  lead: string,
  { maxSentences }: { maxSentences: number }
): LeadDefect[] {
  const defects: LeadDefect[] = [];
  const trimmed = lead.trim();
  if (trimmed.length === 0) {
    defects.push({ kind: "empty", detail: "a lead cannot be empty" });
    return defects;
  }
  if (trimmed.length > LEAD_MAX_CHARS) {
    defects.push({
      kind: "too-long",
      detail: `${trimmed.length} characters, over the ${LEAD_MAX_CHARS}-character two-line budget`,
    });
  }
  const sentences = sentenceCount(trimmed);
  if (sentences > maxSentences) {
    defects.push({
      kind: "too-many-sentences",
      detail: `${sentences} sentences, over the limit of ${maxSentences}`,
    });
  }
  return defects;
}
