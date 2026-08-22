import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_MODE_BREAKPOINT_PX, CARD_MODE_ONLY } from "../card-row";

// THE CARD-MODE BOUNDARY IS ONE NUMBER, HELD IN THREE PLACES (issue #3457).
//
// `lib/card-row.ts` declares it (`CARD_MODE_BREAKPOINT_PX`), the `table-cards`
// family in app/globals.css does the re-laying at it, and every consumer that
// needs markup to exist only on a card inherits `CARD_MODE_ONLY`. #3457 was filed
// because the third group had drifted: requirements and ACs were written in `md`
// while the CSS worked in `max-sm:`, and at 390px and 430px — the only widths
// anyone tested — the two agree, so nothing ever looked wrong.
//
// WHAT THIS TEST IS FOR, AND WHAT IT IS NOT. It holds the DECLARATIONS to one
// number. It says nothing about what a browser renders — that is
// `e2e/card-mode-boundary.spec.ts`, which measures rendered boxes either side of
// the boundary, because a computed style is a declaration and the user sees a
// result (#3466's lesson, #3529's shape).
//
// THE PREDICATE IS "SCOPED TO A BREAKPOINT OTHER THAN THE CARD-MODE ONE", NOT
// "carries a `max-sm:` prefix". "Phone only" has two spellings in globals.css —
// the Tailwind variant prefix and a raw `@media (max-width: 639.98px)` block —
// and two of the raw ones in this file CANNOT be a prefix at all (a `::after`
// pseudo-element with `content`, and #3510's `@layer components` height floor).
// A guard that demanded the prefix would flag three correct, deliberate blocks on
// day one and be deleted within the week, taking the real guard with it (#3325,
// and the measurement is on #3518). An UNSCOPED declaration is silent here too:
// `card-cell-label` has no breakpoint of its own because the span carrying it is
// already `CARD_MODE_ONLY`, and that is correct.
//
// DIRECTION. "No declaration is scoped to the wrong breakpoint" is an ABSENCE,
// and an absence over a text scan goes green the moment the scan stops finding
// declarations (#3509). Three defences, and they guard different failures:
//
//   (a) a census floor on the scoped declarations the scan actually found;
//   (b) NAMED SUBJECTS — the three rules that MAKE a table into cards, required
//       to be present AND card-mode-scoped. A presence claim is the form to
//       prefer here: Tailwind's content scanner reads source as text, so prose
//       can ADD a rule but never delete one (#3523), and a rename or a
//       restructure kills a presence claim loudly instead of quietly;
//   (c) synthetic offenders of both spellings, each beside a benign neighbour
//       the scan must stay silent on.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The utilities that together implement card mode. `card-cell-label` is in the
// family because it is the card's own column label — it carries no breakpoint,
// which this scan must therefore tolerate rather than flag.
const FAMILY = [
  "table-cards",
  "table-section-row",
  "table-nested-row",
  "metric-readings-list",
  "practice-session-list",
  "card-cell-label",
] as const;

// The raw `@media` spelling of the same boundary: Tailwind emits `max-sm:` as
// `@media (width < 40rem)`, and a hand-written block says `max-width: 639.98px`
// for the same range. Derived from the constant so the two cannot drift.
const RAW_MAX_WIDTH_PX = CARD_MODE_BREAKPOINT_PX - 0.02;

// The Tailwind variant that spells the boundary. `CARD_MODE_ONLY` is the class a
// consumer writes for "exists only on a card", so the variant is its prefix —
// derived rather than repeated, which is the whole point of the constant.
const CARD_MODE_VARIANT = CARD_MODE_ONLY.split(":")[0];

interface Scoping {
  /** `@utility` this declaration lives in. */
  utility: string;
  /** How the scope is spelled, verbatim, for the failure message. */
  spelling: string;
  /** True when it scopes to the card-mode boundary or to the desktop side of it. */
  ok: boolean;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// TSX carries its conventions in `//` prose, and a scan that reads source as text
// cannot tell a class string from a sentence about one. The first cut of the
// consumer check below flagged ResponsiveTable's own comment describing the sort
// select — the mirror-image failure recorded on #3509, where a guard fires on the
// documentation that explains it and teaches the next author to stop writing it.
function stripTsComments(source: string): string {
  return stripComments(source).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** The body of each `@utility <name> { … }`, brace-matched. */
export function utilityBodies(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const source = stripComments(css);
  for (const m of source.matchAll(/@utility\s+([a-z0-9-]+)\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.set(m[1], source.slice(open + 1, i));
  }
  return out;
}

/**
 * Every breakpoint-scoped declaration in the given utilities, with a verdict.
 *
 * Both spellings, and the two directions that are legitimate:
 *   - a card-mode scope (`max-sm:`, or `max-width: 639.98px`) — the boundary;
 *   - a desktop-only scope (`min-width: <breakpoint>` at or above it) — a rule
 *     that deliberately applies only where the table is a table. Flagging those
 *     is the cry-wolf direction that gets a guard deleted (#3518).
 * Anything else — a `max-md:` prefix, a `max-width: 767.98px` block, an `md:`
 * variant inside the family — is the drift #3457 exists to stop.
 */
export function scanCardModeScopes(
  bodies: Map<string, string>,
  utilities: readonly string[]
): Scoping[] {
  const out: Scoping[] = [];
  for (const utility of utilities) {
    const body = bodies.get(utility);
    if (body === undefined) continue;
    for (const m of body.matchAll(
      /(?:^|[\s(])(max-)?(sm|md|lg|xl|2xl|3xl):/g
    )) {
      const spelling = `${m[1] ?? ""}${m[2]}:`;
      out.push({
        utility,
        spelling,
        ok: spelling === `max-${CARD_MODE_VARIANT}:`,
      });
    }
    for (const m of body.matchAll(
      /@media\s*\(\s*(max-width|min-width|width)\s*(?::|[<>]=?)\s*([0-9.]+)px\s*\)/g
    )) {
      const [, feature, value] = m;
      const px = Number(value);
      const ok =
        (feature === "max-width" && px === RAW_MAX_WIDTH_PX) ||
        (feature === "min-width" && px >= CARD_MODE_BREAKPOINT_PX);
      out.push({ utility, spelling: `@media (${feature}: ${px}px)`, ok });
    }
  }
  return out;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

describe("card-mode boundary (#3457)", () => {
  const css = read("app/globals.css");
  const bodies = utilityBodies(css);

  it("the constant, the class and Tailwind's own `sm` are one number", () => {
    expect(CARD_MODE_BREAKPOINT_PX).toBe(640);
    expect(CARD_MODE_ONLY).toBe(`${CARD_MODE_VARIANT}:hidden`);
    expect(CARD_MODE_VARIANT).toBe("sm");
    // Tailwind's `sm` is 40rem = 640px unless this file's `@theme` moves it. The
    // registry names this as an unguarded inference (#3466: "it would stop
    // holding if `--breakpoint-sm` moved — nothing in the test suite would
    // notice"). This is the notice.
    const override = /--breakpoint-sm\s*:\s*([^;]+);/.exec(stripComments(css));
    expect(
      override?.[1]?.trim() ?? "40rem",
      "app/globals.css moved Tailwind's `sm` breakpoint. Card mode's boundary " +
        "is CARD_MODE_BREAKPOINT_PX in lib/card-row.ts and every `max-sm:` " +
        "declaration in the `table-cards` family follows `sm`, so the two have " +
        "to move together."
    ).toMatch(/^(40rem|640px)$/);
  });

  it("the whole family scopes to the card-mode boundary and nothing else", () => {
    const found = scanCardModeScopes(bodies, FAMILY);
    // CENSUS FLOOR. Measured 2026-08-22: 89 `max-sm:` prefixes plus one raw
    // `@media (max-width: 639.98px)` block across the six utilities — 90. The
    // floor sits at about half, so ordinary editing does not trip it while a
    // scan that has stopped reading the file does (#3529's shape).
    expect(
      found.length,
      "the card-mode scope scan found almost nothing in app/globals.css — the " +
        "verdict below is then an absence over an empty corpus."
    ).toBeGreaterThan(45);
    expect(
      found.filter((s) => !s.ok).map((s) => `${s.utility}: ${s.spelling}`),
      "a `table-cards`-family declaration is scoped to a breakpoint that is " +
        "not the card-mode boundary. The boundary is CARD_MODE_BREAKPOINT_PX " +
        "in lib/card-row.ts (#3457) and it is `sm`, not `md`: the 640–768px " +
        "band is a designed narrower-table tier, and widening these rules " +
        "would make every `hidden sm:table-cell` column inert."
    ).toEqual([]);
  });

  it("the three rules that MAKE a table into cards are present and scoped", () => {
    // NAMED SUBJECTS, not a count. A count says something was here; these say
    // the thing being claimed about was here. They are also the presence form,
    // which prose cannot reach (#3523) and a rename cannot silence.
    const body = bodies.get("table-cards") ?? "";
    const rules: [string, RegExp][] = [
      ["thead is hidden", /&\s*thead\s*\{[^}]*max-sm:hidden/],
      ["tbody stops being a row group", /&\s*tbody\s*\{[^}]*max-sm:block/],
      ["a row becomes a wrapping flex line", /&\s*tr\s*\{[^}]*max-sm:flex\b/],
    ];
    for (const [what, pattern] of rules)
      expect(
        pattern.test(body),
        `@utility table-cards no longer carries the rule that ${what} at the ` +
          `card-mode boundary. Either card mode moved (say so in ` +
          `lib/card-row.ts and in docs/internals/design-system.md §5) or this ` +
          `scan has gone blind and its clean sweep above meant nothing.`
      ).toBe(true);
  });

  it("the two consumers inherit the boundary instead of restating it", () => {
    // SCOPED TO THE FILES THAT ACTUALLY HAVE A CARD-MODE-ONLY ELEMENT. A
    // tree-wide "nobody may write `sm:hidden`" would be wrong: plenty of
    // surfaces hide something at `sm` for reasons that have nothing to do with
    // a table becoming cards.
    for (const rel of [
      "components/ResponsiveTable.tsx",
      "components/TableSortSelect.tsx",
    ]) {
      const text = read(rel);
      expect(
        text.includes("CARD_MODE_ONLY"),
        `${rel} renders markup that exists only in card mode, so it takes the ` +
          `boundary from CARD_MODE_ONLY (lib/card-row.ts) rather than writing ` +
          `a variant of its own (#3457).`
      ).toBe(true);
      const literals = [
        ...stripTsComments(text).matchAll(
          /["'`][^"'`]*\b(max-)?(sm|md):hidden\b/g
        ),
      ].map((m) => m[0]);
      expect(
        literals,
        `${rel} hardcodes the card-mode boundary in a class string. That is ` +
          `the second copy of a number that has to agree with app/globals.css ` +
          `and with every AC — import CARD_MODE_ONLY instead.`
      ).toEqual([]);
    }
  });

  describe("the scan can see, and stays quiet on its benign neighbours", () => {
    // A green sweep over a COMPLYING tree says nothing about what the sweep can
    // see (#3325). Both spellings of the offence, and both directions.
    const offenders: [string, string][] = [
      [
        "a `max-md:` prefix — the exact edit #3457 declined to make",
        "@utility table-cards {\n  & tr { @apply max-md:flex; }\n}",
      ],
      [
        "a raw media block at the `md` boundary, which no prefix scan sees",
        "@utility table-cards {\n  @media (max-width: 767.98px) {\n    & tr { display: flex; }\n  }\n}",
      ],
      [
        "an `md:` min-width variant inside the family",
        "@utility metric-readings-list {\n  & td { @apply md:table-cell; }\n}",
      ],
    ];
    for (const [what, source] of offenders)
      it(`flags ${what}`, () => {
        const found = scanCardModeScopes(utilityBodies(source), FAMILY);
        expect(found.filter((s) => !s.ok)).not.toEqual([]);
      });

    const benign: [string, string][] = [
      [
        "the raw phone-only block metric-readings-list really has",
        "@utility metric-readings-list {\n  @media (max-width: 639.98px) {\n    & td::after { content: \"\"; }\n  }\n}",
      ],
      [
        "a deliberately desktop-only block inside a utility",
        "@utility table-cards {\n  @media (min-width: 640px) {\n    & tr { border-bottom-width: 1px; }\n  }\n}",
      ],
      [
        "card-cell-label's unscoped declarations — the span is already CARD_MODE_ONLY",
        "@utility card-cell-label {\n  @apply mr-1 text-xs uppercase;\n}",
      ],
      [
        "a scope inside a utility that is not in the family at all",
        "@utility chart-card-plot {\n  & > * { @apply max-md:h-40; }\n}",
      ],
    ];
    for (const [what, source] of benign)
      it(`stays silent on ${what}`, () => {
        const found = scanCardModeScopes(utilityBodies(source), FAMILY);
        expect(found.filter((s) => !s.ok)).toEqual([]);
      });
  });
});
