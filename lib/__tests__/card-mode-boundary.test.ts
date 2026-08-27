import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CARD_MODE_BREAKPOINT_PX,
  CARD_MODE_ONLY,
  CARD_MODE_ROW_STACK,
  CARD_MODE_TABLE_ONLY,
} from "../card-row";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";

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
  // The five EntryHistoryTable surfaces' compact logged-event row (#3671): a
  // timeline of one fact each, collapsed to a line below the boundary with its
  // labelled detail one tap away.
  "logged-event-rows",
  // Not a table at all (#3495): the Settings → Notifications kind × channel
  // matrix, whose four channel columns become labeled chips below the boundary.
  // It is in the family because it answers the same question the table utilities
  // do — "what does this surface become on a phone" — and because a surface that
  // declared that in `max-md:` would be exactly the #3457 drift, on a card the
  // 640–768px band renders as a four-column grid.
  "notification-kind-matrix",
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

// CSS ONLY. `//` is not a comment in CSS, so the shared TypeScript scanner
// (./strip-comments) is the wrong tool for a stylesheet — it would read the `//`
// in a `url(https://…)` as one and blank the rest of the line. TSX below uses the
// shared scanner, which is the right tool there.
function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The body of each `@utility <name> { … }`, brace-matched. */
export function utilityBodies(css: string): Map<string, string> {
  const out = new Map<string, string>();
  const source = stripCssComments(css);
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

// ── WHO THE CONSUMERS ARE, DERIVED (#3601) AND WHAT IS FORBIDDEN OF THEM (#3552) ──
//
// The consumer half of this guard was a hand-written list of three files with no
// floor: measured 2026-08-23, setting it to `[]` left 12/12 passing, and
// `components/ClinicalResultsTable.tsx:370` wrote `"sm:hidden"` — character for
// character the value of CARD_MODE_ONLY — on card-mode-only markup without anything
// noticing. #3457 recurring inside the check that closed #3457.
//
// THESE TWO ISSUES ARE ONE CHANGE, and the measurement is why. Deriving membership
// (#3601) puts 20 files on the list. Measured 2026-08-23, TEN of them carry a `sm:`
// or `md:` class literal that has nothing to do with card mode — `md:grid-cols-…`
// on a layout, `input sm:w-40` on three settings fields, `hidden md:table-cell`
// column tiers, `sm:px-5` padding. Under the old predicate — "a listed consumer may
// write NO responsive literal at all" — the derivation reds ten correct files on its
// first run, so it cannot be done without #3552's narrowing; and narrowing alone
// leaves the list a list somebody has to remember to append to. Neither half is
// shippable without the other.
//
// THE NARROWED PREDICATE, DERIVED FROM THE CONSTANTS RATHER THAN WRITTEN OUT. The
// question is "does this file restate the CARD-MODE boundary", not "does it carry a
// breakpoint". So the forbidden set is built from what the exported constants
// actually say: their tier (CARD_MODE_VARIANT) crossed with the utilities they name
// (`hidden` from CARD_MODE_ONLY, `basis-full` and `whitespace-normal` from
// CARD_MODE_ROW_STACK), in both directions of the tier. A responsive class at that
// tier doing anything else — a width, a gap, a grid template — is styling, not a
// second copy of the number, and flagging it is the cry-wolf direction that got a
// large surface kept OFF the list entirely (#3552 / PR #3550).
//
// PHONE-ONLY HAS TWO SPELLINGS and a TSX file can reach for the other one: a raw
// media query in a `matchMedia` call is the same restatement as a class prefix.
// Both are derived from CARD_MODE_BREAKPOINT_PX below.
//
// THE ONE ARGUABLE MEMBER, RULED ON RATHER THAN LEFT QUIET (#3620). The illness
// timeline's "show N earlier days" toggle is phone-only progressive disclosure, and
// it was open whether that makes it PAGE-level markup — which would put it on a
// licensed-exemption list — or card-mode markup, which keeps it inside this guard.
// It is card-mode markup, and the argument is its twin rather than its wording: the
// rows the toggle reveals are `<tbody>` groups carrying the ABOVE-boundary half of
// the very same fold, so the two are one contract with two halves. Exempting the
// toggle would license exactly the drift this guard exists for — a control that
// stops matching the rows it controls. It stays on the list, both halves import a
// constant, and the named-subject assertion below requires both.
//
// THERE IS NO EXEMPTION LIST, AND THAT IS THE RULING, not an omission. If a later
// case genuinely is page-level, it needs one, with the argument attached — never a
// quiet removal from the derived population.

/** Files under these roots are candidates; nothing else renders a card. */
const CONSUMER_ROOTS = ["app", "components"];

/**
 * THE FLOOR THE DERIVED CONSUMER SET MUST CLEAR, asserted before any verdict is
 * pronounced over it. The verdict is an ABSENCE — "nobody restates the boundary" —
 * and the old list had no floor at all, which is how emptying it stayed green.
 *
 * Measured 2026-08-23 at this head: 20 files, by three signals (6 name a family
 * class, 15 import the card DOM, 7 import lib/card-row; the sets overlap). Slack on
 * purpose: a surface adopting `@utility` instead of `<Td>` legitimately leaves the
 * population (#3495 / PR #3550 did exactly that).
 */
const CONSUMER_FLOOR = 12;

/**
 * The utilities the exported constants themselves name.
 *
 * TOKENISED RATHER THAN SLICED (#3620), because the mirror constant is not one
 * class. "This exists only ABOVE the boundary" is a PAIR — a base `hidden` and a
 * scoped restoration — so `CARD_MODE_TABLE_ONLY.inline` is `hidden sm:inline`.
 * Only the scoped tokens carry the boundary; the bare `hidden`/`hidden!` half
 * carries no tier and is nobody's restatement. The `!` important marker comes off
 * too, so a restatement that omits it is caught by the same literal.
 */
const CARD_MODE_UTILITIES = [
  ...new Set(
    [
      CARD_MODE_ONLY,
      CARD_MODE_ROW_STACK.text,
      CARD_MODE_ROW_STACK.lead,
      ...Object.values(CARD_MODE_TABLE_ONLY),
    ]
      .flatMap((cls) => cls.split(/\s+/))
      .filter((token) => token.includes(":"))
      .map((token) => token.slice(token.indexOf(":") + 1).replace(/!$/, ""))
  ),
];

/**
 * The class literals that ARE the card-mode boundary: its tier, in both directions,
 * applied to the utilities the constants use. `sm:w-40` is not one of them.
 */
const FORBIDDEN_CLASS_LITERALS = CARD_MODE_UTILITIES.flatMap((utility) => [
  `${CARD_MODE_VARIANT}:${utility}`,
  `max-${CARD_MODE_VARIANT}:${utility}`,
]);

/**
 * The same boundary written as a raw media query — what a `matchMedia` call or an
 * inline style block would say. Tailwind emits the tier as `width < 40rem`; a
 * hand-written block says `max-width: 639.98px`; the desktop side says
 * `min-width: 640px`. All three are derived from the constant.
 */
const FORBIDDEN_RAW_QUERIES = [
  `max-width: ${RAW_MAX_WIDTH_PX}px`,
  `min-width: ${CARD_MODE_BREAKPOINT_PX}px`,
  `width < ${CARD_MODE_BREAKPOINT_PX / 16}rem`,
  `width >= ${CARD_MODE_BREAKPOINT_PX / 16}rem`,
];

const escapeRe = (v: string): string =>
  v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does this source render one of the card-mode family utilities as a class token? */
function namesFamilyClass(source: string): string[] {
  return FAMILY.filter((c) =>
    new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(source)
  );
}

export interface CardModeConsumer {
  rel: string;
  /** Why this file is a consumer — the signals that put it on the list. */
  signals: string[];
}

/**
 * Every file that renders markup whose arrangement changes at the card-mode
 * boundary, derived from the tree rather than remembered in a list.
 *
 * Three signals, each of which means the file is inside the card contract:
 * it names a `table-cards`-family utility, it imports the card DOM
 * (`ResponsiveTable`/`Td`), or it imports the boundary's own module.
 *
 * `sources` is keyed by repo-relative path and must already be COMMENT-BLANKED —
 * prose in this tree quotes the classes it explains, and the first cut of the old
 * consumer check fired on ResponsiveTable's own documentation (#3509's shape).
 */
export function deriveCardModeConsumers(
  sources: ReadonlyMap<string, string>
): CardModeConsumer[] {
  const out: CardModeConsumer[] = [];
  for (const [rel, source] of sources) {
    const signals: string[] = [];
    const family = namesFamilyClass(source);
    if (family.length) signals.push(`renders ${family.join(", ")}`);
    if (/from\s+["'][^"']*\/ResponsiveTable["']/.test(source))
      signals.push("imports the card DOM (ResponsiveTable/Td)");
    if (/from\s+["'][^"']*\/card-row["']/.test(source))
      signals.push("imports lib/card-row");
    if (signals.length) out.push({ rel, signals });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Every place a consumer RESTATES the card-mode boundary instead of importing it,
 * as `rel:line — spelling`.
 *
 * Narrowed per #3552: only the tier the boundary uses, only the utilities the
 * exported constants name, plus the raw media-query spellings of the same number.
 * Anything else responsive is styling and is none of this guard's business.
 */
export function cardModeRestatements(
  consumers: readonly CardModeConsumer[],
  sources: ReadonlyMap<string, string>
): string[] {
  const out: string[] = [];
  for (const { rel } of consumers) {
    const source = sources.get(rel) ?? "";
    for (const literal of FORBIDDEN_CLASS_LITERALS) {
      const re = new RegExp(`(?<![\\w-])${escapeRe(literal)}(?![\\w-])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)))
        out.push(
          `${rel}:${source.slice(0, m.index).split("\n").length} — \`${literal}\``
        );
    }
    for (const query of FORBIDDEN_RAW_QUERIES) {
      const re = new RegExp(escapeRe(query).replace(/\\?\s+/g, "\\s*"), "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(source)))
        out.push(
          `${rel}:${source.slice(0, m.index).split("\n").length} — \`${query}\``
        );
    }
  }
  return out.sort();
}

/** Comment-blanked sources for every `.ts`/`.tsx` file under the consumer roots. */
function consumerSources(base: string = REPO): Map<string, string> {
  const files = execFileSync(
    "git",
    ["ls-files", "-z", "--", ...CONSUMER_ROOTS],
    {
      cwd: base,
      maxBuffer: 64 * 1024 * 1024,
    }
  )
    .toString("utf8")
    .split("\0")
    .filter((f) => /\.tsx?$/.test(f) && !f.includes("__tests__"));
  return new Map(
    files.map((f) => [
      f,
      stripComments(fs.readFileSync(path.join(base, f), "utf8")),
    ])
  );
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
    const override = /--breakpoint-sm\s*:\s*([^;]+);/.exec(
      stripCssComments(css)
    );
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
    // CENSUS FLOOR. Re-derived 2026-08-22 with #3495's utility in the family:
    // 121 `max-sm:` prefixes plus one raw `@media (max-width: 639.98px)` block
    // across the seven utilities — 122. (It read 89 + 1 = 90 over six before
    // `notification-kind-matrix`, which contributes 32.) The floor sits a little
    // under half, so ordinary editing does not trip it while a scan that has
    // stopped reading the file does (#3529's shape).
    //
    // THE NUMBER IS WHAT `scanCardModeScopes` RETURNS, NEVER WHAT A GREP COUNTS,
    // and the difference is not academic: this scan reads COMMENT-STRIPPED utility
    // bodies, and the prose inside a utility routinely spells the variant it is
    // explaining. `notification-kind-matrix` has a comment block saying "Every rule
    // below is `max-sm:`", so `git grep -c 'max-sm:'` over that utility reads 33
    // against the scan's 32. An earlier revision of this comment recorded 111/21
    // for a scan that returned 112/22 — a guard whose entire discipline is "the
    // number was measured" cannot afford a recorded measurement that is not what
    // the scan produces, and the way to keep it honest is to take the number from
    // the scanner rather than from a text search that sees a different corpus.
    expect(
      found.length,
      "the card-mode scope scan found almost nothing in app/globals.css — the " +
        "verdict below is then an absence over an empty corpus."
    ).toBeGreaterThan(55);
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

  it("the row-stack classes spell the SAME variant, derived not typed (#3491)", () => {
    // CARD_MODE_ROW_STACK is the non-table half of the boundary: a flex line
    // whose actions wrap beneath its text below `sm`. Tailwind's scanner reads
    // source as text, so the variant has to be a literal SOMEWHERE — the point
    // of putting it in lib/card-row.ts is that this is the one place it can be
    // held to the declared number.
    expect(CARD_MODE_ROW_STACK.text).toBe(
      `max-${CARD_MODE_VARIANT}:basis-full`
    );
    expect(CARD_MODE_ROW_STACK.lead).toBe(
      `max-${CARD_MODE_VARIANT}:whitespace-normal`
    );
  });

  it("the ABOVE-boundary mirror spells the same variant, derived not typed (#3620)", () => {
    // `CARD_MODE_ONLY` names the half that shows only BELOW the boundary. Its
    // mirror was a literal everywhere, so nothing caught a restatement of the
    // other half — and a fold whose halves go out of step shows an element in
    // both modes or in neither.
    expect(CARD_MODE_TABLE_ONLY.inline).toBe(
      `hidden ${CARD_MODE_VARIANT}:inline`
    );
    expect(CARD_MODE_TABLE_ONLY.tableRowGroup).toBe(
      `hidden! ${CARD_MODE_VARIANT}:table-row-group!`
    );

    // AND THE FORBIDDEN SET GREW WITH IT, which is the second half of #3620: the
    // predicate is derived from what the constants NAME, so naming the mirror is
    // what makes a restatement of it visible. Asserted as membership rather than
    // as a count, so adding a constant does not have to come back here.
    for (const literal of [
      `${CARD_MODE_VARIANT}:inline`,
      `max-${CARD_MODE_VARIANT}:inline`,
      `${CARD_MODE_VARIANT}:table-row-group`,
      `max-${CARD_MODE_VARIANT}:table-row-group`,
    ])
      expect(FORBIDDEN_CLASS_LITERALS).toContain(literal);

    // AND THE COLUMN LADDER STAYED OUT OF IT. `hidden sm:table-cell` is the middle
    // rung of the three-step column tier this file's header describes, not a
    // card-mode fold: inside a card its `hidden` half is inert, because
    // `.table-cards td[data-card]` (0,2,1) outranks `.hidden` (0,1,0). Nine shipped
    // declarations spell it across three consumers, and flagging them would be the
    // cry-wolf direction that kept a large surface off the list entirely (#3552).
    expect(FORBIDDEN_CLASS_LITERALS).not.toContain(
      `${CARD_MODE_VARIANT}:table-cell`
    );
  });

  it("the named consumers inherit the boundary instead of restating it", () => {
    // NAMED SUBJECTS, kept as PRESENCE claims. The derived census below is what
    // makes membership honest; these three say that the specific files the boundary
    // was built for still import it, which a derivation cannot say — a file can
    // stop importing the constant and simply leave the derived population.
    //
    // Each entry names the export it is required to import. A consumer that stacks
    // a row (#3491's Trash list) inherits a different constant than one that hides
    // card-mode-only markup, and demanding CARD_MODE_ONLY of both would be a guard
    // that fires on correct code.
    //
    // THE TWO TWIN PAIRS ARE NAMED AS PAIRS (#3620). Each is one fold with two
    // halves, and the failure this guards against is the halves going out of step —
    // so each file is required to import BOTH constants, and losing either import
    // is the red. A derivation cannot say this: a file that dropped one half would
    // still be a consumer by the other.
    const named: [string, string][] = [
      ["components/ResponsiveTable.tsx", "CARD_MODE_ONLY"],
      ["components/TableSortSelect.tsx", "CARD_MODE_ONLY"],
      ["app/(app)/data/TrashList.tsx", "CARD_MODE_ROW_STACK"],
      // The illness timeline's earlier-days fold: the phone-only toggle and the
      // row groups it toggles. See the exemption note below for why the toggle is
      // card-mode markup and not page-level progressive disclosure.
      ["components/illness/EpisodeTimeline.tsx", "CARD_MODE_ONLY"],
      ["components/illness/EpisodeTimeline.tsx", "CARD_MODE_TABLE_ONLY"],
      // The sleep history's date pair: short date on the card, long date in the
      // table, one `<Link>`, two spans.
      ["app/(app)/sleep/SleepMoodSection.tsx", "CARD_MODE_ONLY"],
      ["app/(app)/sleep/SleepMoodSection.tsx", "CARD_MODE_TABLE_ONLY"],
    ];
    for (const [rel, symbol] of named)
      expect(
        stripComments(read(rel)).includes(symbol),
        `${rel} renders markup whose arrangement changes at the card-mode ` +
          `boundary, so it takes that boundary from ${symbol} ` +
          `(lib/card-row.ts) rather than writing a variant of its own (#3457).`
      ).toBe(true);
  });

  describe("the consumer census, derived from the tree (#3601, #3552)", () => {
    const sources = consumerSources();
    const consumers = deriveCardModeConsumers(sources);

    it("derives a population before pronouncing anything about it", () => {
      expect(
        consumers.length,
        `The derivation found ${consumers.length} card-mode consumers, below the ` +
          `floor of ${CONSUMER_FLOOR}. The verdict below is an absence, so a ` +
          "derivation that has stopped finding files agrees that nobody restates " +
          "the boundary. Emptying the old hand-written list left 12/12 green."
      ).toBeGreaterThanOrEqual(CONSUMER_FLOOR);

      // PER SIGNAL, because the total clears the floor while one signal has
      // silently stopped matching — the card-DOM import alone would carry it, and a
      // moved import path is exactly how that happens.
      for (const signal of [
        "renders",
        "imports the card DOM",
        "imports lib/card-row",
      ])
        expect(
          consumers.filter((c) => c.signals.some((x) => x.startsWith(signal)))
            .length,
          `No consumer at all by the \`${signal}\` signal. Either that way of ` +
            "joining the card contract has gone out of use, or this derivation " +
            "has stopped seeing it — and the second one is silent."
        ).toBeGreaterThan(0);

      // And the named subjects are inside the population they are named from. A
      // derivation that does not reach the three files this guard was built for is
      // not describing the same thing the list did.
      const rels = new Set(consumers.map((c) => c.rel));
      for (const rel of [
        "components/ResponsiveTable.tsx",
        "components/TableSortSelect.tsx",
        "app/(app)/data/TrashList.tsx",
      ])
        expect(rels, `${rel} fell out of the derived consumer set`).toContain(
          rel
        );
    });

    it("no consumer restates the boundary as a literal", () => {
      const restatements = cardModeRestatements(consumers, sources);
      expect(
        restatements,
        "A card-mode consumer spells the boundary itself instead of importing it. " +
          "That is the second copy of a number that has to agree with " +
          "app/globals.css and with every AC — import CARD_MODE_ONLY, " +
          "CARD_MODE_TABLE_ONLY or CARD_MODE_ROW_STACK from lib/card-row.ts " +
          "(#3457, #3620). Only the card-mode " +
          "tier's own utilities are forbidden here: an unrelated responsive class " +
          "at any tier is styling and this guard says nothing about it (#3552).\n" +
          restatements.join("\n")
      ).toEqual([]);
    });
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
        '@utility metric-readings-list {\n  @media (max-width: 639.98px) {\n    & td::after { content: ""; }\n  }\n}',
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

// Everything in the consumer census above is a claim about the LIVE tree, which
// already complies — a green sweep over it says nothing about what the sweep can
// see (#3325). These run the same derivation and the same predicate over a corpus
// authored to break them: real files written to disk, tracked in a real git
// repository, read back through the same `git ls-files` walk. #3552's acceptance
// criterion says the offender must be PLANTED IN THE SCANNED CORPUS rather than
// handed to the matcher, and that is the difference between proving the predicate
// and proving the census.
//
// A CORPUS OF ITS OWN, never the live tree: vitest runs test files concurrently and
// several other guards walk `app/` and `components/` and read them a moment later,
// so a create-then-unlink there kills unrelated tests with ENOENT (measured on
// #3557's tap-floor census). `makeTmpDir` keeps this file out of the temp-dir
// census's findings (#3248).
describe("the consumer census over a corpus authored to break it (#3601, #3552)", () => {
  const base = makeTmpDir("card-mode-consumers");

  const SEEDS: ReadonlyArray<readonly [string, string]> = [
    // A consumer by each signal, so the readings below are not three empties
    // agreeing. Each one is CLEAN: it inherits the boundary or names none.
    [
      "components/ByFamilyClass.tsx",
      'export const A = () => <table className="table-cards" />;\n',
    ],
    [
      "app/(app)/by-card-dom/page.tsx",
      'import { Td } from "@/components/ResponsiveTable";\nexport default () => <Td slot="title" />;\n',
    ],
    [
      "components/ByCardRow.tsx",
      'import { CARD_MODE_ONLY } from "@/lib/card-row";\nexport const C = () => <span className={CARD_MODE_ONLY} />;\n',
    ],
    // NOT a consumer: it renders responsive markup and knows nothing about cards.
    [
      "components/Bystander.tsx",
      'export const D = () => <input className="input sm:w-40 md:grid-cols-2" />;\n',
    ],
    // NOT a consumer either, and this is the one that matters: it names the family
    // in PROSE in order to explain it. `components/MedicalFilters.tsx`,
    // `components/OverflowMenu.tsx` and TrainingOverviewActions all do exactly this
    // in the real tree, and a census that read them as consumers would then demand
    // things of files that render no card at all (#3509's shape).
    [
      "components/AboutTheFamily.tsx",
      '// `.table-cards tr.table-section-row` is how a group heading is laid out.\nexport const E = () => <div className="sm:hidden" />;\n',
    ],
  ];

  const write = (rel: string, source: string): void => {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, source, "utf8");
  };
  // `-f` so a global excludes file cannot quietly drop a plant and hand this test a
  // green it did not earn.
  const track = (): void => {
    execFileSync("git", ["-C", base, "add", "-f", "-A"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  };

  execFileSync("git", ["init", "-q", base], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [rel, source] of SEEDS) write(rel, source);
  track();

  const censusOf = (): { rels: string[]; restatements: string[] } => {
    const sources = consumerSources(base);
    const consumers = deriveCardModeConsumers(sources);
    return {
      rels: consumers.map((c) => c.rel),
      restatements: cardModeRestatements(consumers, sources),
    };
  };

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("derives exactly the files inside the card contract, and no bystander", () => {
    // The prose file is the load-bearing one: it carries `sm:hidden` AND names two
    // family classes, so a census that counted its comment would report a
    // restatement in a file that renders no card.
    expect(censusOf().rels).toEqual([
      "app/(app)/by-card-dom/page.tsx",
      "components/ByCardRow.tsx",
      "components/ByFamilyClass.tsx",
    ]);
    expect(censusOf().restatements).toEqual([]);
  });

  it("sees a restatement planted in a consumer, at its line", () => {
    // The live case, reproduced: `sm:hidden` on card-mode-only markup inside a file
    // that renders the card DOM. It was `components/ClinicalResultsTable.tsx:370`.
    write(
      "components/Planted.tsx",
      [
        'import { Td } from "@/components/ResponsiveTable";',
        "export const P = ({ isStart }: { isStart: boolean }) => (",
        '  <Td slot="title">',
        '    <span className={isStart ? undefined : "sm:hidden"} />',
        "  </Td>",
        ");",
        "",
      ].join("\n")
    );
    track();
    expect(censusOf().restatements).toEqual([
      "components/Planted.tsx:4 — `sm:hidden`",
    ]);
    fs.rmSync(path.join(base, "components/Planted.tsx"));
    track();
    // Additive, not a rewrite — which is what makes the reading above mean anything.
    expect(censusOf().restatements).toEqual([]);
  });

  it("sees the phone-only spelling and the row-stack utilities too", () => {
    write(
      "components/PlantedVariants.tsx",
      [
        'import { CARD_MODE_ONLY } from "@/lib/card-row";',
        "export const P = () => (",
        "  <div>",
        "    <span className={CARD_MODE_ONLY} />",
        '    <span className="max-sm:hidden" />',
        '    <span className="max-sm:basis-full" />',
        '    <span className="max-sm:whitespace-normal" />',
        "  </div>",
        ");",
        "",
      ].join("\n")
    );
    track();
    expect(censusOf().restatements).toEqual([
      "components/PlantedVariants.tsx:5 — `max-sm:hidden`",
      "components/PlantedVariants.tsx:6 — `max-sm:basis-full`",
      "components/PlantedVariants.tsx:7 — `max-sm:whitespace-normal`",
    ]);
    fs.rmSync(path.join(base, "components/PlantedVariants.tsx"));
    track();
    expect(censusOf().restatements).toEqual([]);
  });

  it("sees a restatement of the ABOVE-boundary half (#3620)", () => {
    // THE HALF THAT NOTHING CAUGHT. Until CARD_MODE_TABLE_ONLY existed, every one
    // of these lines was invisible to this guard while its below-boundary twin was
    // caught — which is the state that lets one half of a fold drift and show an
    // element in both modes or in neither. The important marker is stripped when
    // the literal is derived, so the `!` spelling and the bare one are one rule.
    write(
      "components/PlantedMirror.tsx",
      [
        'import { Td } from "@/components/ResponsiveTable";',
        "export const P = () => (",
        "  <div>",
        '    <span className="hidden sm:inline" />',
        '    <tbody className="hidden! sm:table-row-group!" />',
        '    <span className="max-sm:inline" />',
        "  </div>",
        ");",
        "",
      ].join("\n")
    );
    track();
    expect(censusOf().restatements).toEqual([
      "components/PlantedMirror.tsx:4 — `sm:inline`",
      "components/PlantedMirror.tsx:5 — `sm:table-row-group`",
      "components/PlantedMirror.tsx:6 — `max-sm:inline`",
    ]);
    fs.rmSync(path.join(base, "components/PlantedMirror.tsx"));
    track();
    expect(censusOf().restatements).toEqual([]);
  });

  it("sees the boundary written as a raw media query", () => {
    // #3552's "phone-only has two spellings". In TSX the second one is a
    // `matchMedia` string, and `components/ActivityEditorProvider.tsx:773` already
    // spells `(min-width: 640px)` that way — outside the card contract today, but
    // the same number.
    write(
      "components/PlantedQuery.tsx",
      [
        'import { Td } from "@/components/ResponsiveTable";',
        'const CARDS = "(max-width: 639.98px)";',
        'const TABLE = "(min-width: 640px)";',
        'export const P = () => <Td slot="title">{CARDS}{TABLE}</Td>;',
        "",
      ].join("\n")
    );
    track();
    expect(censusOf().restatements).toEqual([
      "components/PlantedQuery.tsx:2 — `max-width: 639.98px`",
      "components/PlantedQuery.tsx:3 — `min-width: 640px`",
    ]);
    fs.rmSync(path.join(base, "components/PlantedQuery.tsx"));
    track();
    expect(censusOf().restatements).toEqual([]);
  });

  it("stays silent on the unrelated responsive classes #3552 was filed for", () => {
    // THE CRY-WOLF DIRECTION, and the reason a large surface stayed off the old
    // list rather than joining it. Every literal here is at a tier the boundary
    // does not own, or is a utility the constants never name. A guard that flagged
    // these would be deleted within a week, taking the real guard with it.
    write(
      "components/PlantedBenign.tsx",
      [
        'import { Td } from "@/components/ResponsiveTable";',
        "export const P = () => (",
        "  <div>",
        '    <input className="input sm:w-40" />',
        '    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_20rem]" />',
        // The middle rung of the COLUMN LADDER, and the reason `table-cell` is not
        // in CARD_MODE_TABLE_ONLY: in card mode its `hidden` half is inert, because
        // `.table-cards td[data-card]` (0,2,1) outranks `.hidden` (0,1,0). Nine
        // shipped declarations across three consumers spell it.
        '    <th className="hidden sm:table-cell" />',
        // NOT CAUGHT, AND KNOWN: `sm:block` is a mirror spelling the constants do
        // not name, because no consumer folds with it — measured 2026-08-23, zero
        // occurrences of `sm:block` or `max-sm:block` inside the 20 derived
        // consumers. The predicate is the constants, so the day a card consumer
        // needs that fold, the fix is a `block` entry beside `inline`, not a
        // hand-written literal here (#3552).
        '    <div className="hidden sm:block" />',
        '    <td className="px-2 pb-2 sm:px-5 sm:pt-4" />',
        '    <span className="max-md:h-40 lg:flex xl:hidden" />',
        '    <Td slot="meta" />',
        "  </div>",
        ");",
        "",
      ].join("\n")
    );
    track();
    expect(
      censusOf().restatements,
      "The narrowed predicate fired on ordinary responsive styling. That is the " +
        "state #3552 was filed about: the surfaces most worth watching are the big " +
        "ones, and they are the ones most likely to carry an unrelated `sm:`."
    ).toEqual([]);
    fs.rmSync(path.join(base, "components/PlantedBenign.tsx"));
    track();
  });

  it("goes quiet when the derivation collapses — which is why the floor exists", () => {
    // The fail-open shape this whole change is about, made visible: with no
    // consumers derived, the restatement verdict agrees that nobody restates
    // anything. Only the floor above can tell that reading apart from a clean tree.
    const empty = new Map<string, string>();
    expect(deriveCardModeConsumers(empty)).toEqual([]);
    expect(cardModeRestatements([], empty)).toEqual([]);
  });
});
