import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The phone density conventions (issue #3466) — a source scan in the tradition of
// bottom-edge-tokens.test.ts, over the two spacing layers that #3466 stepped down.
//
// The regression this freezes is NOT "the numbers changed". It is the one #3466
// was filed to prevent: eight per-file numbers instead of one convention. A sweep
// that lands `max-sm:p-3` at eight call sites has spent the effort and bought
// nothing, because the ninth sub-panel added next month inherits nothing — so the
// value of this work is entirely in there being exactly ONE place each step is
// written, and this test is what makes that checkable.
//
// Four rules:
//   1. app/globals.css declares every tier of both conventions, once each.
//   2. Every tier is a `max-sm:` override carrying `!`. This is the DESKTOP-SAFETY
//      proof and it is structural rather than measured: a `max-sm:` variant emits
//      only inside `@media (width < 40rem)`, so at >=`sm` these classes contribute
//      nothing at all and there is no per-site desktop value to get wrong. (Checked
//      against the compiled sheet while #3466 was written: all seven rules land
//      inside that one media query, `!important` included, and nowhere else.) The
//      `!` is load-bearing for the OTHER direction — Tailwind 4 sorts custom
//      utilities independently of source order, so without it a call site's own
//      `p-4` could win the tie and the convention would apply or not depending on
//      generated order.
//   3. Every site #3466 enumerated still carries its tier class, next to the inset
//      it steps down FROM. The pair is the review moment: a call site that changes
//      its desktop padding has to come here and re-pick its tier.
//   4. NOBODY outside app/globals.css hand-writes a phone step for these two
//      properties. This is the rule that keeps a second convention from quietly
//      appearing beside the first, which is the actual failure mode #3466 names.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = "app/globals.css";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// A class token, not a substring. `subpanel-inset` is a PREFIX of
// `subpanel-inset-xs`, `section-seam` of `section-seam-lg`, `section-stack` of
// `section-stack-sm` — so a `toContain` check lets any tier be swapped for its
// own longer sibling with the census still green, and a 16-in-16 box could
// silently step to 8px instead of 12px. Every tier assertion below goes through
// here.
function classToken(name: string): RegExp {
  return new RegExp(
    `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
  );
}

function hasClass(source: string, name: string): boolean {
  return classToken(name).test(source);
}

// The opening JSX tag carrying `needle`, found by scanning OUT from that
// attribute rather than by matching the first `className=` in the file. The
// difference is the whole point: a file-level `/className="([^"]*)"/` reads
// whichever element happens to come first, so re-adding `card` to a component
// AND switching its own className to a template literal would hand the assertion
// a DIFFERENT element's class list — both `not.toBeNull()` and `not.toContain`
// pass, on an element nobody asked about, and the nest is quietly back.
function openingTagWith(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at < 0) throw new Error(`no element carries ${needle}`);
  const start = source.lastIndexOf("<", at);
  if (start < 0) throw new Error(`${needle} is not inside a JSX tag`);
  // Forward to this tag's own `>`, stepping over any `{...}` expression — an
  // arrow function's `=>` lives inside one.
  let depth = 0;
  for (let i = at; i < source.length; i += 1) {
    const c = source[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated JSX tag around ${needle}`);
}

// That tag's className VALUE — the quoted string or the whole braced expression,
// interpolations included, so a class smuggled into a `${cond ? "card" : ""}` is
// still in scope. Comments inside the tag are NOT: this file's own subject
// components carry prose mentioning `.card` in order to explain why they are not
// one, and a guard that fired on that explanation would be deleted.
function classNameValue(tag: string): string {
  const at = tag.indexOf("className=");
  if (at < 0) throw new Error("tag carries no className");
  let i = at + "className=".length;
  if (tag[i] === '"') {
    const end = tag.indexOf('"', i + 1);
    return tag.slice(i + 1, end);
  }
  if (tag[i] !== "{") throw new Error("unrecognised className form");
  let depth = 0;
  const start = i;
  for (; i < tag.length; i += 1) {
    if (tag[i] === "{") depth += 1;
    else if (tag[i] === "}") {
      depth -= 1;
      if (depth === 0) return tag.slice(start + 1, i);
    }
  }
  throw new Error("unterminated className expression");
}

function classesOn(source: string, needle: string): string {
  return classNameValue(openingTagWith(source, needle));
}

// tier -> the phone value it sets. Desktop is whatever the call site already had.
const TIERS = new Map<string, string>([
  // Class A — a padded box INSIDE a padded card. Keyed by the inset the box
  // carries today, because that is what a call site looks at to pick one.
  ["subpanel-inset", "p-3"], // from p-4 (16) / p-4 sm:p-5
  ["subpanel-inset-sm", "p-2.5"], // from p-3 (12)
  ["subpanel-inset-xs", "p-2"], // from p-2.5 (10)
  // Class C — the vertical seam BETWEEN page sections.
  ["section-seam", "mb-4"], // from mb-6 (24)
  ["section-seam-lg", "mb-6"], // from mb-8 (32)
  ["section-stack", "space-y-6"], // from space-y-10 (40)
  ["section-stack-sm", "space-y-4"], // from space-y-6 (24)
]);

// Every site #3466's table names, plus the same-shape siblings on the same card
// that the convention has to reach for the surface to read as one thing: file ->
// (tier, the inset it steps down from). A new sub-panel is added here, which is
// the point — the list is a census, not a changelog.
const SITES: ReadonlyArray<readonly [string, string, string]> = [
  // A. Boxed sub-panels inside cards, worst first (the issue's own order).
  ["app/(app)/settings/ai/AiTierSettings.tsx", "subpanel-inset", "p-4"],
  ["components/practices/PracticeTrends.tsx", "subpanel-inset", "p-4 sm:p-5"],
  ["app/(app)/settings/server/BackupSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/server/SmtpSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/family/FamilyManager.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/TrainingWatchCard.tsx", "subpanel-inset-sm", "p-3"],
  ["components/FindingRow.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/EndurancePlanBar.tsx", "subpanel-inset-sm", "py-3"],
  ["app/(app)/training/MuscleCoverageCard.tsx", "subpanel-inset-xs", "p-2.5"],
  ["app/(app)/encounters/AppointmentList.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/longevity/PillarStat.tsx", "subpanel-inset-xs", "p-2.5"],
  // B. The unwrapped card-in-card, which lands as a sub-panel of its host card.
  ["components/IntegrationSyncHistoryLink.tsx", "subpanel-inset", "p-4"],
  // C. The seams the sweep flagged by name.
  ["app/(app)/records/VisitsSection.tsx", "section-stack", "space-y-10"],
  ["app/(app)/records/VisitsSection.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/whats-new/page.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/results/BioAgeInputsCard.tsx", "section-seam", "mb-6"],
  ["components/dashboard/DashboardAhead.tsx", "section-seam-lg", "mb-8"],
  [
    "components/dashboard/DashboardStandingCluster.tsx",
    "section-seam-lg",
    "mb-8",
  ],
  ["app/(app)/wellness/page.tsx", "section-seam-lg", "mb-8"],
];

// Rule 4's scan, and its width is the point. The first version read
// `max-sm:(p-…|mb-…|space-y-…)`, which catches `max-sm:mb-4` and lets
// `max-sm:px-3`, `max-sm:pt-2`, `max-sm:py-2.5`, `max-sm:mt-3` and
// `max-sm:space-x-2` walk straight past — half the spellings of the very thing
// the rule exists to stop, in a guard whose whole job is that nobody starts a
// second convention. A guard that can only see the spelling its author had in
// mind turns "nobody has done this" into "nobody can do this", and only the
// first is true.
//
// It matches a phone-scoped padding, margin or space STEP: a numeric value on
// `p`/`m` with any direction, or on `space-x`/`space-y`. It deliberately does NOT
// match `-auto` alignment (`max-sm:ml-auto` and `max-sm:mr-auto` both ship today
// and are not spacing steps), nor `gap-*`, which is intra-component layout rather
// than either of the two gutter layers this convention owns. Both silences are
// asserted below, because a guard that cries wolf on shipped, correct code is
// deleted within a week and takes the real guard with it.
const OWNED_STEP =
  /max-sm:-?(?:[mp][trblxy]?|space-[xy])-\d+(?:\.\d+)?(?![\w-])/;

// The three test directories are excluded and nothing else is: a spec that NAMES
// the forbidden spelling in order to argue about it — this file does, twice — is
// not a call site, and a guard that fires on its own source gets deleted.
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
  for (const d of ["app", "components", "lib"]) walk(d);
  return out.filter((f) => !NOT_A_CALL_SITE.test(f));
}

describe("phone density conventions (#3466)", () => {
  const css = read(GLOBALS);

  it("rule 1+2: every tier is declared once in app/globals.css, as a max-sm override carrying !", () => {
    for (const [tier, phoneValue] of TIERS) {
      const declarations = [
        ...css.matchAll(new RegExp(`@utility ${tier} \\{`, "g")),
      ];
      expect(
        declarations.length,
        `${tier} must be declared exactly once in ${GLOBALS} — it is the single place its phone step is written`
      ).toBe(1);

      // The body, verbatim and WHOLE. `toContain` was not enough and the comment
      // here already promised more than it delivered: `@apply sm:p-6;` could be
      // added beside the step and the tier would still "contain" its own
      // spelling — putting a desktop value inside the one construction whose
      // entire guarantee is that it cannot have one.
      const opened = css.indexOf(`@utility ${tier} {`);
      const body = css
        .slice(opened + `@utility ${tier} {`.length, css.indexOf("}", opened))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      expect(
        body,
        `${tier}'s body must be EXACTLY '@apply max-sm:${phoneValue}!;' and nothing else — the max-sm variant is what makes desktop identical by construction, and the ! is what makes the convention beat a call site's own padding regardless of Tailwind's generated order`
      ).toBe(`@apply max-sm:${phoneValue}!;`);
    }
  });

  it("rule 3: every site #3466 enumerated carries its tier next to the inset it steps down from", () => {
    for (const [file, tier, from] of SITES) {
      const src = read(file);
      expect(
        hasClass(src, tier),
        `${file} must carry ${tier} as its own class token (#3466) — a substring match here would accept ${tier}-sm or ${tier}-xs in its place, which is a different step`
      ).toBe(true);
      expect(
        src,
        `${file} must still carry its own '${from}' — the convention is an ADDITION beside the desktop vocabulary, never a replacement for it; a site that drops it has moved its desktop value too`
      ).toContain(from);
    }
  });

  // A card that pads with `p-0!` and lets its CELLS carry the gutter has one
  // padding layer, not two — so a "sub-panel" inset there IS the #1416 card token,
  // and stepping it tightens the very floor #3466 declares untouchable. Measured
  // while #3466 was implemented: the strip's text would have sat 4px left of every
  // other card's text in a vertical stack at 390px. #3466's table lists this site
  // and says the table was "verified in code"; for THIS row that claim does not
  // hold, and the owner reverted it on 2026-08-21. Asserted rather than commented,
  // because the next reader working the table will otherwise "finish" it.
  it("a card that delegates its own gutter to its cells is NOT a sub-panel site (#3466, owner-reverted)", () => {
    const src = read("app/(app)/trends/VitalsTodayStrip.tsx");
    // Read off the STRIP'S OWN tag, not the file. A file-level `toContain("p-0!")`
    // stays satisfied by any `p-0!` anywhere in the file, so the card could take
    // back a real `p-4` — falsifying the very premise this exemption rests on —
    // while an inner cell kept the substring alive and the exemption outlived its
    // reason in silence. That is the `why`-went-false failure, in the guard that
    // exists to prevent it.
    const strip = classesOn(src, 'data-testid="vitals-today-strip"').split(
      /\s+/
    );
    expect(
      strip,
      "the strip's own section must still be `p-0!` — this exemption is true only while the CARD carries no padding of its own"
    ).toContain("p-0!");
    expect(
      strip,
      "…and it must still BE the card, or the premise is about a different element"
    ).toContain("card");
    for (const tier of TIERS.keys()) {
      if (!tier.startsWith("subpanel-")) continue;
      expect(
        hasClass(src, tier),
        `VitalsTodayStrip must not carry ${tier}: its card is \`p-0!\`, so \`px-4 py-3.5\` is the card's OWN gutter reproducing the #1416 token, not a second layer inside it`
      ).toBe(false);
    }
  });

  it("rule 4: nobody outside app/globals.css hand-writes a phone step for these properties", () => {
    const offenders = sourceFiles().filter((f) => OWNED_STEP.test(read(f)));
    expect(
      offenders,
      "a per-file `max-sm:p-*` / `max-sm:mb-*` / `max-sm:space-y-*` is the second convention #3466 exists to prevent — add a tier to app/globals.css and use it"
    ).toEqual([]);
  });

  // A green sweep over a COMPLYING tree says nothing about what the sweep can see.
  // Rule 4's pattern is run here over sources authored to BREAK it and over the
  // benign neighbours it must stay quiet on — the second half matters as much as
  // the first, because a guard that fires on shipped, correct code gets deleted
  // and takes the real guard with it.
  it("rule 4's pattern can SEE every spelling of the step, and stays quiet on what is not one", () => {
    const caught = [
      'className="max-sm:p-3"', // the shape the original pattern already saw
      'className="max-sm:px-3"', // …and five it did not
      'className="max-sm:py-2.5"',
      'className="max-sm:pt-2"',
      'className="max-sm:pb-1"',
      'className="max-sm:mt-3"',
      'className="max-sm:mb-4"',
      'className="max-sm:m-2"',
      'className="max-sm:-mt-2"', // a negative step is still a step
      'className="max-sm:space-x-2"',
      'className="max-sm:space-y-4"',
      "className={`flex ${x} max-sm:pl-2`}", // inside a template literal
    ];
    for (const source of caught) {
      expect(
        OWNED_STEP.test(source),
        `rule 4 must SEE ${source} — a guard blind to the spelling everyone reaches for turns "nobody has done this" into "nobody can do this"`
      ).toBe(true);
    }

    const quiet = [
      'className="max-sm:ml-auto"', // ships today (ProtocolControls) — alignment, not a step
      'className="max-sm:mr-auto"', // ships today (ActivityPartsList) — same
      'className="max-sm:mx-auto"',
      'className="sm:p-3"', // a DESKTOP value is not this convention's business
      'className="p-3 sm:p-4"',
      'className="max-sm:flex max-sm:flex-wrap"',
      'className="max-sm:min-h-10"', // a tap floor, not a gutter
      'className="max-sm:gap-2"', // intra-component layout, neither gutter layer
      'className="max-sm:rounded-none"',
      'className="subpanel-inset section-seam"', // the convention itself
    ];
    for (const source of quiet) {
      expect(
        OWNED_STEP.test(source),
        `rule 4 must stay QUIET on ${source} — it is not a phone-scoped padding or margin step, and a guard that cries wolf on it will be deleted`
      ).toBe(false);
    }
  });

  // The same question one level down, for the tier names themselves.
  it("a tier is matched as a class token, never as a prefix of its longer sibling", () => {
    expect(hasClass('className="subpanel-inset-xs"', "subpanel-inset")).toBe(
      false
    );
    expect(hasClass('className="section-seam-lg"', "section-seam")).toBe(false);
    expect(hasClass('className="section-stack-sm"', "section-stack")).toBe(
      false
    );
    // …while the real thing still matches, beside other classes and inside a
    // template literal.
    expect(
      hasClass('className="p-4 subpanel-inset flex"', "subpanel-inset")
    ).toBe(true);
    expect(
      hasClass("className={`mb-6 section-seam ${x}`}", "section-seam")
    ).toBe(true);
  });

  it("the two card-in-card nests draw one border each (#3466 class B)", () => {
    // /data mounts IntegrationsGrid — itself a grid of `.card`s — so its wrapper
    // may not be one. Read off the WRAPPER'S OWN tag, located by its id: the page
    // has many legitimate cards.
    const dataPage = read("app/(app)/data/page.tsx");
    expect(
      hasClass(classesOn(dataPage, 'id="integrations"'), "card"),
      "the integrations wrapper may not be a `.card` — the grid inside it already draws one border per source"
    ).toBe(false);

    // The takeout page's Status card is this link's only host, and it mounts it
    // INSIDE that card. Anchored on the link's OWN tag for the same reason the
    // wrapper above is anchored on its id, and it was NOT before: matching the
    // first `className=` in the file reads `SyncTimestamp`'s the moment this
    // component's own className becomes a template literal, so `card` could be
    // re-hardcoded here and both assertions would pass — on an element nobody
    // asked about.
    const link = read("components/IntegrationSyncHistoryLink.tsx");
    expect(
      hasClass(classesOn(link, 'data-testid="sync-history-link"'), "card"),
      "IntegrationSyncHistoryLink may not hardcode `card` on itself — every host it has mounts it inside one"
    ).toBe(false);
  });
});
