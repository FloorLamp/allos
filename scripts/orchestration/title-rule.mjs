// The title rule (#4983), owned in one place because two things enforce it:
// the merge gate refuses a non-conforming PR title, and tracker reconciliation
// flags an over-long issue title for a human. One rule, two readers.
//
// The rule, from the owner's 2026-09-03 ruling: 72 characters, ONE CLAUSE, no
// colon or dash tail; the detail is the body's first line. A PR title becomes
// the squash commit's subject, which is why the bound is a subject-line width.
//
// 72 CHARACTERS OF WHAT: grapheme clusters, because the rule exists so a title
// survives a truncating list and a grapheme is what a reader sees there. The
// three candidate counts agree on the whole live corpus — measured 2026-09-03,
// no open issue title had a code-point count differing from its UTF-16 length
// — so this can only bite on an emoji or a combining mark, and there the
// reader's count is the one that should decide. A curly apostrophe and an em
// dash, which real titles here DO carry, cost one under every count.
//
// WHAT COUNTS AS A TAIL: the banned shape is a clause, a separator, a second
// clause carrying the detail, so the SEPARATOR is what is detected. The
// discriminator is SPACING, taken from how this repo spells these titles
// rather than from how the rule describes them (measured 2026-09-03 over the
// 315 open issue titles):
//
//   * A COLON FOLLOWED BY WHITESPACE splits a clause — 162 of 315 carry one,
//     and every one of them does. The 3 carrying a colon NOT followed by
//     whitespace are `::after`, `auth.test.ts:326` and `The 10:00Z–12:00Z
//     anchor band`: a pseudo-element, a line citation and a time. A colon
//     inside a token is not a boundary, and POSITION does not matter — a colon
//     nine characters in still leaves everything after it as the tail.
//
//   * A DASH WITH WHITESPACE ON BOTH SIDES splits a clause; a dash inside a
//     token does not (`10:00Z–12:00Z`, `items 2-3`, `pre-#3938` are ranges and
//     compounds). U+2212 MINUS is deliberately not a dash here — a live title
//     reads `top − m42`, which is arithmetic.
//
//   * SPACED DASHES PAIR OFF: two enclose a parenthetical and the title is
//     still one clause ("the walk exists twice — in A and in B — and nothing
//     keeps them agreeing", a live title). An ODD count leaves one unpaired,
//     and the unpaired one is the tail. Both directions matter — a gate that
//     refused a time or a mid-clause dash would be routed around in a day.
//
// A TRAILING `(#N …)` REFERENCE is excepted from the clause scan and ONLY from
// it: removed before the separators are counted, still counted in the length,
// because the squash subject carries it and the reader pays for it.
//
// Usage:  node scripts/orchestration/title-rule.mjs "<title>"
// Exit 0 = the title holds. Exit 1 = it breaks the rule, one violation to a
// line. Exit 2 = there was no title to check.

import { helpGuard, isMain } from "./usage.mjs";
helpGuard(process.argv, import.meta.url);

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

/** The rule in one sentence, quoted to every reader so nobody looks it up. */
const RULE =
  `the rule is ${TITLE_MAX_CHARACTERS} characters max, one clause, no colon ` +
  "or dash tail (#4983); the detail is the body's first line";

/** The refusal a human reads, or null when the title holds. */
export function titleRuleRefusal(subject, title) {
  const violations = titleRuleViolations(title);
  if (violations.length === 0) return null;
  return `${subject} title ${violations.join(" and ")} — ${RULE}`;
}

// THE COMMAND — the same rule read a third way, by a lane checking a title
// BEFORE it opens the PR, which is where the dispatch brief points it.
//
// This file shipped without any of it (#5068). Run as a command it defined its
// exports and fell off the end: nothing printed and the exit was 0 for every
// string, including the colon tails the merge gate then refused an hour later
// on an open PR. A check that cannot fail is worse than no check, because the
// person who ran it reasonably believes they have checked — so the EXIT CODE
// is the deliverable here, not the printing.
function main(argv) {
  const title = argv[0];
  if (title === undefined || title.trim() === "") {
    console.error('usage: title-rule.mjs "<title>"  (--help prints the rule)');
    return 2;
  }
  const violations = titleRuleViolations(title);
  // A conforming title says so out loud rather than exiting silently: silence
  // and 0 is exactly what the broken version did, and a reader cannot tell a
  // working check from a dead one by its absence of output.
  if (violations.length === 0) {
    console.log(`title is one clause of ${titleLength(title)} characters`);
    return 0;
  }
  for (const violation of violations) console.log(`title ${violation}`);
  console.log(RULE);
  return 1;
}

if (isMain(process.argv, import.meta.url))
  process.exitCode = main(process.argv.slice(2));
