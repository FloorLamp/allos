// The title rule (#4983), owned in one place because two things enforce it:
// the merge gate refuses a non-conforming PR title, and tracker reconciliation
// flags an over-long issue title for a human. One rule, two readers.
//
// THE RULE, from the owner's 2026-09-03 ruling: 72 characters max, ONE CLAUSE,
// no colon or dash tail. The detail belongs in the body's first line. A PR
// title also becomes the squash commit's subject, which is why the length is
// the same number as a readable subject line.
//
// ── WHAT COUNTS AS A CHARACTER ──────────────────────────────────────────────
//
// GRAPHEME CLUSTERS, because the rule exists so a title survives a truncating
// list, and a grapheme is what a reader sees there. The three candidate counts
// AGREE on the whole live corpus — measured 2026-09-03 over the 315 open issue
// titles, none had a code-point count differing from its UTF-16 length — so
// this choice can only ever matter for a title carrying an emoji, a flag or a
// combining mark, and there the reader's count is the one that should decide.
// A curly apostrophe and an em dash, which real titles here DO carry, cost one
// under every count.
//
// ── WHAT COUNTS AS A TAIL ───────────────────────────────────────────────────
//
// The banned shape is a clause, a separator, and a second clause carrying the
// detail. So the separator is what is detected, and the discriminator is
// SPACING, taken from how this repo actually writes these titles rather than
// from how the rule describes them (measured 2026-09-03):
//
//   * A COLON FOLLOWED BY WHITESPACE (or ending the title) is a separator.
//     162 of 315 open issue titles carry one, and every one of them splits a
//     clause. The 3 that carry a colon NOT followed by whitespace are
//     `::after`, `auth.test.ts:326` and `The 10:00Z–12:00Z anchor band` — a
//     pseudo-element, a line citation and a time. Those are inside a token,
//     and a token is not a clause boundary. Position does not matter: a colon
//     nine characters in still leaves everything after it as the tail.
//
//   * A DASH WITH WHITESPACE ON BOTH SIDES is a separator; a dash inside a
//     token is not. `10:00Z–12:00Z`, `items 2-3` and `pre-#3938` are ranges
//     and compounds, and none of them is a clause boundary. U+2212 MINUS is
//     deliberately not a dash here — a live title reads `top − m42`, which is
//     arithmetic.
//
//   * SPACED DASHES PAIR OFF. Two of them enclose a parenthetical and the
//     title is still one clause ("the walk now exists twice — in A and in B —
//     and nothing keeps them agreeing"). An ODD count leaves one unpaired, and
//     the unpaired one is the tail. This is the direction that has to be got
//     right in both senses: a gate that refused a legitimate mid-clause dash
//     or a time would be routed around within a day.
//
// A TRAILING `(#N …)` PARENTHETICAL is excepted from the clause scan, and only
// from it. The exception is about the TAIL, so the parenthetical is removed
// before the separators are counted and is still COUNTED IN THE LENGTH — a
// squash subject carries it, so the reader pays for it.

export const TITLE_MAX_CHARACTERS = 72;

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

/** How long a title is, in the characters a reader counts. */
export function titleLength(title) {
  return [...GRAPHEMES.segment(title)].length;
}

/** The reference a PR title may carry after its clause: `(#4712 judgement 1)`. */
const TRAILING_REFERENCE = /\s*\(#\d+[^()]*\)$/;

/** A colon that ends a word rather than sitting inside one. */
const COLON_SEPARATOR = /:(?:\s|$)/;

/** A dash with whitespace or an edge on both sides. */
const SPACED_DASH = /(?:^|\s)[-–—](?=\s|$)/g;

/**
 * Why this title breaks the rule, as clauses to join — empty when it holds.
 *
 * Both halves are reported together: a title that is long AND two-clause needs
 * one rewrite, not two rounds of the same gate.
 */
export function titleRuleViolations(title) {
  const violations = [];
  const length = titleLength(title);
  if (length > TITLE_MAX_CHARACTERS) {
    violations.push(`is ${length} characters`);
  }
  const clause = title.replace(TRAILING_REFERENCE, "");
  if (COLON_SEPARATOR.test(clause)) {
    violations.push("carries a colon tail");
  } else if ((clause.match(SPACED_DASH)?.length ?? 0) % 2 === 1) {
    violations.push("carries a dash tail");
  }
  return violations;
}

/** The refusal a human reads, or null when the title holds. */
export function titleRuleRefusal(subject, title) {
  const violations = titleRuleViolations(title);
  if (violations.length === 0) return null;
  return (
    `${subject} title ${violations.join(" and ")} — the rule is ` +
    `${TITLE_MAX_CHARACTERS} characters max, one clause, no colon or dash ` +
    "tail (#4983); the detail is the body's first line"
  );
}
