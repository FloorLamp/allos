import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The chip primitive and the stat tile (issue #3475), guarded in the tradition of
// mobile-density-convention.test.ts.
//
// The regression this freezes is NOT "the colours changed". It is the one #3475
// was filed about: a container grammar with no chip row and no stat-tile row, so
// every strip invents its own. `app/(app)/training/AnalyzeSection.tsx` drew TWO
// pills in ONE file with different padding and different selected brand shades;
// the range chips drew a third selected-state language and stacked it directly
// above FilterPills' in the dose ledger. The value of this work is entirely in
// there being exactly ONE place a chip's shape, size and selected state are
// written, so this test is what makes that checkable.
//
// Four rules:
//   1. app/globals.css declares the primitive once — `chip`, its dense `chip-sm`
//      size, the two roles #3408 ruled (`chip-nav`, `chip-filter`), and
//      `stat-tile` — and each
//      role paints its LIT STATE FROM THE ARIA rather than from a call site's
//      ternary, so a chip cannot look selected without announcing that it is.
//   2. The declared adopters render through it, and hand-roll nothing locally.
//   3. A tree-wide census of hand-rolled chip-shaped class strings matches a
//      NAMED list, so the next hand-rolled strip has to come here first.
//   4. Rule 3's pattern can SEE the spellings this repo actually uses, and stays
//      quiet on the neighbours it must not fire on.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = "app/globals.css";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// The body of an `@utility <name> { … }` block, by brace matching. A substring
// search would let one utility's declarations be read as another's the moment two
// blocks sit adjacent, which is exactly how `chip-nav` and `chip-filter` sit.
function utilityBody(css: string, name: string): string {
  const head = `@utility ${name} {`;
  const at = css.indexOf(head);
  if (at < 0) throw new Error(`app/globals.css declares no @utility ${name}`);
  let depth = 0;
  for (let i = at + head.length - 1; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(at + head.length, i);
    }
  }
  throw new Error(`unterminated @utility ${name}`);
}

// ── Rule 3's pattern ────────────────────────────────────────────────────────
//
// WHAT COUNTS AS A HAND-ROLLED CHIP, spelled the way this repo spells it rather
// than the way the issue described it. #3475's body says "48 files free-styling
// `rounded-full` borders", and a scan for `rounded-full border` would have been
// green against half the defect: the range chips are BORDERLESS fill pills
// (#3475's own first comment), FilterPills is `rounded-md`, and neither would
// have matched. What every one of them DOES share is the shape:
//
//   a class string that pairs a PILL RADIUS with HORIZONTAL PADDING and switches
//   on a condition
//
// so that is what this matches, over template literals — because the switch is
// what makes it a chip rather than a static badge, and a template literal is the
// only way to write one in this codebase.
const PILL_RADIUS = /rounded-(?:full|md)(?![\w-])/;
const H_PADDING = /\bpx-\d/;
const SWITCHES = /\?/;

// A template literal, non-greedy, backticks included. Nested backticks would end
// the span early; none of the 25 recorded sites has one, and the census floor
// below is what would notice if that stopped being true.
const TEMPLATE_LITERAL = /`[^`]*`/gs;

// COMMENTS ARE BLANKED BEFORE THE SCAN, because a scan over raw source counts
// PROSE AS CODE — the same trap an e2e-hygiene census hit when it flagged
// `.first()` written in an English sentence. Measured here on 2026-08-22:
// blanking removes ~4,000 of the ~7,400 backtick spans in app/ + components/
// (comment prose in this codebase is full of them) and moves the offender set by
// EXACTLY ZERO files, before the sweep and after it. So the blanking is not what
// produces the numbers below; it is what stops a future comment producing one.
function blankComments(src: string): string {
  const keepLines = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead: string) =>
      lead === "" ? keepLines(m) : lead + keepLines(m.slice(lead.length))
    );
}

// The three test directories are excluded and nothing else is: this file NAMES
// the forbidden spelling in order to argue about it, twice, and a guard that
// fires on its own source gets deleted.
const NOT_A_CALL_SITE = /^lib\/__(tests|db_tests|action_tests)__\//;

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(rel);
    }
  };
  for (const d of ["app", "components"]) walk(d);
  return out.filter((f) => !NOT_A_CALL_SITE.test(f));
}

function isHandRolledChip(literal: string): boolean {
  return (
    PILL_RADIUS.test(literal) &&
    H_PADDING.test(literal) &&
    SWITCHES.test(literal)
  );
}

type Scan = { files: number; literals: number; hits: Map<string, number> };

function scan(): Scan {
  const hits = new Map<string, number>();
  let literals = 0;
  const files = sourceFiles();
  for (const f of files) {
    const src = blankComments(read(f));
    for (const lit of src.match(TEMPLATE_LITERAL) ?? []) {
      literals += 1;
      if (isHandRolledChip(lit)) hits.set(f, (hits.get(f) ?? 0) + 1);
    }
  }
  return { files: files.length, literals, hits };
}

// ── The census (rule 3) ─────────────────────────────────────────────────────
//
// Every chip-shaped conditional LEFT after #3525's dense-strip sweep. The list
// is a census, not a changelog: a new entry must be either converted or named.
// `deferred` is Timeline's independently owned chrome lane; `not-a-chip` is a
// known pattern over-match. A pill radius plus padding
//                   plus a ternary also describes a severity badge, a menu row,
//                   a count bubble, and `components/SegmentedControl.tsx`, which
//                   is a registered primitive of its own with its own `--seg-*`
//                   tokens. These are recorded rather than excluded by a cleverer
//                   pattern, because every exclusion is a hole and a named
//                   over-match is not.
const CENSUS: readonly (readonly [
  string,
  number,
  "deferred" | "not-a-chip",
  string,
])[] = [
  [
    "app/(app)/timeline/TimelineScrubber.tsx",
    1,
    "not-a-chip",
    "the floating date bubble — nothing selects it; the ternary is a pulse animation",
  ],
  [
    "app/(app)/timeline/page.tsx",
    2,
    "deferred",
    "category filter strip; explicitly owned by Timeline's chrome lane",
  ],
  [
    "components/DuplicateReview.tsx",
    1,
    "not-a-chip",
    "a severity badge — non-interactive, and `badge` is its primitive",
  ],
  [
    "components/ProfileSwitcherPanel.tsx",
    2,
    "not-a-chip",
    "a full-width menu ROW and an uppercase role badge inside it",
  ],
  [
    "components/SegmentedControl.tsx",
    1,
    "not-a-chip",
    "a registered primitive of its own, on the `--seg-*` token pair (#2701)",
  ],
  [
    "components/SessionComparisonChart.tsx",
    1,
    "not-a-chip",
    "a grid row whose current-state background makes the pattern over-match",
  ],
  [
    "components/SessionRecapView.tsx",
    1,
    "not-a-chip",
    "a tone badge (emerald/amber) — `badge`'s family",
  ],
];

// The primitive's declared adopters (#3475's sweep). Each renders through the
// primitive AND — the fail-closed half — hand-rolls nothing locally, so a chip
// re-grown inside one of these files reds even though the file also still
// carries the primitive's class.
const ADOPTERS: readonly (readonly [string, string])[] = [
  ["components/FilterPills.tsx", "chip chip-filter"],
  ["components/DateRangeControl.tsx", "chip chip-filter"],
  ["app/(app)/records/RecordsTabs.tsx", "chip chip-nav"],
  ["app/(app)/training/AnalyzeSection.tsx", "chip chip-nav"],
  ["app/(app)/trends/ChartJumpChips.tsx", "chip chip-nav"],
  ["app/(app)/settings/SettingsSubPageNav.tsx", "chip chip-nav"],
  ["components/ImportTabStrip.tsx", "chip chip-nav chip-sm"],
  [
    "app/(app)/integrations/patient-portals/PortalsSurface.tsx",
    "chip chip-filter chip-sm",
  ],
  ["app/(app)/nutrition/FoodLogBar.tsx", "chip chip-filter chip-sm"],
  ["app/(app)/progress/ProgressPhotosView.tsx", "chip chip-filter chip-sm"],
  ["app/(app)/training/GoalForm.tsx", "chip chip-filter chip-sm"],
  ["app/(app)/training/MobilityLogBar.tsx", "chip chip-filter"],
  ["app/(app)/training/RoutineBuilder.tsx", "chip chip-filter chip-sm"],
  ["app/(app)/training/TrainingLogView.tsx", "chip chip-filter"],
  [
    "app/(app)/training/activity/[id]/SessionTelemetryChart.tsx",
    "chip chip-filter",
  ],
  ["components/AnnotationToggleBar.tsx", "chip chip-filter chip-sm"],
  ["components/DayHistory.tsx", "chip chip-filter chip-sm"],
  ["components/IntakeItemForm.tsx", "chip chip-filter"],
  ["components/activity-form/RestTimer.tsx", "chip chip-filter chip-sm"],
  ["components/household/HouseholdHistoryTimeline.tsx", "chip chip-filter"],
  ["components/illness/EpisodeTimeline.tsx", "chip chip-filter chip-sm"],
  ["components/photo/PhotoGallery.tsx", "chip chip-filter chip-sm"],
];

describe("the chip primitive and the stat tile (#3475)", () => {
  it("rule 1: app/globals.css declares the primitive once, and each role paints its lit state FROM the aria", () => {
    const css = read(GLOBALS);
    for (const name of [
      "chip",
      "chip-sm",
      "chip-nav",
      "chip-filter",
      "stat-tile",
    ]) {
      const declarations = css.split(`@utility ${name} {`).length - 1;
      expect(
        declarations,
        `app/globals.css must declare @utility ${name} exactly once — two declarations is the drift this primitive exists to close`
      ).toBe(1);
    }

    // ONE padding, both roles: the size lives on the base, so a role cannot
    // re-decide it. This is the assertion that would have caught #3475's actual
    // defect — `py-1.5` in one strip and `py-1` in the next, in one file.
    const base = utilityBody(css, "chip");
    expect(base, "the chip's size belongs to the base class").toMatch(
      /\bpx-3\b/
    );
    expect(base).toMatch(/\bpy-1\.5\b/);
    const small = utilityBody(css, "chip-sm");
    expect(small, "chip-sm records the existing dense scale (#3525)").toMatch(
      /\bpx-2\.5\b/
    );
    expect(small).toMatch(/\bpy-0\.5\b/);
    expect(small).toMatch(/\btext-xs\b/);
    expect(
      css,
      "chip-sm uses the shared hit-area mechanism with an 11px extension, making its 22px paint box 44px effective"
    ).toMatch(/\.chip-sm::after\s*\{[\s\S]*?inset:\s*-0\.6875rem/);
    for (const role of ["chip-nav", "chip-filter"]) {
      const body = utilityBody(css, role);
      expect(
        H_PADDING.test(body),
        `${role} must not restate horizontal padding — one padding scale is the point`
      ).toBe(false);

      // The lit state keys on the attribute, never on a class a call site could
      // spell differently. Both spellings, because link-mode strips say
      // `aria-current` and callback-mode strips say `aria-pressed`.
      expect(
        body,
        `${role} must paint its selected state from aria-current, so a chip cannot look selected without announcing it`
      ).toContain('&[aria-current]:not([aria-current="false"])');
      expect(body).toContain('&[aria-pressed="true"]');
    }

    // The two roles stay TOLD APART (#3408): one is full-round, the other is not.
    expect(utilityBody(css, "chip-nav")).toMatch(/rounded-full(?![\w-])/);
    expect(utilityBody(css, "chip-filter")).toMatch(/rounded-md(?![\w-])/);

    // No height floor, deliberately — see the primitive's own note and #3514,
    // which is unruled on whether the registry's tap floor is 40 or 44. A floor
    // added here would silently answer a question nobody has answered.
    for (const name of ["chip", "chip-nav", "chip-filter"]) {
      expect(
        utilityBody(css, name),
        `${name} must declare no height floor: #3514 is open and unruled, and \`min-block-size\` REPLACES rather than composes (#3510)`
      ).not.toMatch(/min-(?:block-size|height|h-\d)/);
    }
  });

  it("rule 1b: the stat tile is tokened, and wears the SURFACE radius", () => {
    const body = utilityBody(read(GLOBALS), "stat-tile");
    expect(
      body,
      "the tile's fill is the --ghost token, not a hand-maintained light/dark literal pair"
    ).toContain("var(--ghost)");
    expect(
      body,
      "a tile holds content and is not a control, so it takes --radius-card (#2701's two radii)"
    ).toContain("var(--radius-card)");
    expect(body).not.toMatch(/bg-slate-|bg-ink-|rounded-lg/);

    const statBox = blankComments(read("components/StatBox.tsx"));
    expect(statBox, "StatBox is the blessed tier and renders the tile").toMatch(
      /(?<![\w-])stat-tile(?![\w-])/
    );
    expect(
      statBox,
      "StatBox's literal fill pair is what #3475 named; it must not come back"
    ).not.toMatch(/bg-slate-50|bg-ink-900/);

    // The page-local bordered tile on /medical/cycles folded into the tier
    // (#3475's second comment). Match on the IMPORT, which is what membership
    // actually is — a name grep would also match a comment mentioning it.
    expect(
      read("app/(app)/medical/cycles/page.tsx"),
      "/medical/cycles' page-local Stat folded into StatBox"
    ).toContain('from "@/components/StatBox"');
  });

  it("rule 2: every declared adopter renders through the primitive and hand-rolls nothing", () => {
    for (const [file, classes] of ADOPTERS) {
      const src = blankComments(read(file));
      expect(src, `${file} must render through the primitive`).toContain(
        classes
      );
      const local = (src.match(TEMPLATE_LITERAL) ?? []).filter(
        isHandRolledChip
      );
      expect(
        local,
        `${file} adopted the primitive and then hand-rolled a chip beside it — that is the drift, not a fix`
      ).toEqual([]);
    }
  });

  it("rule 3: the hand-rolled census is exactly the recorded list", () => {
    const { files, literals, hits } = scan();

    // THE CENSUS FLOOR, and it is the half that makes the list mean anything.
    // "The offender set matches the list" is an ABSENCE assertion about every
    // file NOT on it, and an absence assertion goes green the moment the scan
    // stops finding anything — a renamed directory, a walk that throws on an
    // empty tree, a regex that stopped matching. Assert the scan READ the tree
    // before believing what it says about the tree.
    expect(
      files,
      "the scan must still be reading app/ and components/"
    ).toBeGreaterThan(900);
    expect(
      literals,
      "the scan must still be finding template literals to look at"
    ).toBeGreaterThan(2500);

    const found = [...hits].map(([f, n]) => `${f} ×${n}`).sort();
    const expected = CENSUS.map(([f, n]) => `${f} ×${n}`).sort();
    expect(
      found,
      "a hand-rolled chip is either converted to `chip chip-nav` / `chip chip-filter` or recorded in CENSUS with the reason it cannot be"
    ).toEqual(expected);

    // The dense-strip work-list is closed; only Timeline's separately owned
    // category strip may remain as a selectable-chip hit.
    const outstanding = CENSUS.filter(([, , tag]) => tag === "deferred").length;
    expect(
      outstanding,
      "only Timeline's explicitly deferred chrome lane remains"
    ).toBe(1);
  });

  // A green sweep over a COMPLYING tree says nothing about what the sweep can
  // see. Rule 3's pattern is run here over sources authored to BREAK it and over
  // the benign neighbours it must stay quiet on — the second half matters as
  // much as the first, because a guard that fires on shipped, correct code gets
  // deleted and takes the real guard with it.
  it("rule 4: the pattern SEES every spelling of a hand-rolled chip, and stays quiet on what is not one", () => {
    const caught = [
      // The two AnalyzeSection strips, verbatim in shape — the defect itself.
      "`rounded-full border px-3 py-1.5 text-sm ${current ? A : B}`",
      "`rounded-full border px-3 py-1 text-sm ${active ? A : B}`",
      // Borderless fill pills: #3475's own first comment says the
      // `rounded-full border` grep misses these entirely.
      "`rounded-full px-3 py-1 ${active ? A : B}`",
      // rounded-md, which is what the app's ONE filter affordance uses.
      "`rounded-md px-3 py-1.5 ${active ? A : B}`",
      // Dense scales, prefixed utilities, and a leading class — all shipped
      // spellings in the census above.
      "`rounded-full border px-2.5 py-0.5 text-xs ${on ? A : B}`",
      "`tap-target rounded-full px-3 py-1.5 ${x ? A : B}`",
      "`shrink-0 rounded-full px-3 py-1 transition ${!category ? A : B}`",
    ];
    for (const source of caught) {
      expect(
        isHandRolledChip(source),
        `the census must SEE ${source} — a guard blind to the spelling everyone reaches for turns "nobody has done this" into "nobody can do this"`
      ).toBe(true);
    }

    const quiet = [
      // The primitive itself. A chip that adopted it is a STATIC string with no
      // radius and no padding in it at all, which is the whole point.
      '"chip chip-nav"',
      '"chip chip-filter"',
      "`chip chip-nav ${extra}`",
      // A status dot / avatar ring — round, but no horizontal padding.
      "`h-2.5 w-2.5 rounded-full ${on ? A : B}`",
      // `badge` is the non-interactive status primitive and is not this.
      "`badge ${tone === 'warn' ? A : B}`",
      // A padded box that is not pill-shaped.
      "`rounded-lg px-3 py-2 ${active ? A : B}`",
      // A pill with no condition in it is a static shape, not a selectable chip.
      "`rounded-full px-3 py-1 text-sm font-medium`",
    ];
    for (const source of quiet) {
      expect(
        isHandRolledChip(source),
        `the census must stay QUIET on ${source} — a guard that cries wolf on shipped, correct code is deleted within a week and takes the real guard with it`
      ).toBe(false);
    }
  });
});
