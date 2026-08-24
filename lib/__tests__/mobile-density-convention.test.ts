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

// That tag's className expression — the quoted string, or the whole braced
// expression with its interpolations. Comments inside the tag are NOT included:
// this file's own subject components carry prose mentioning `.card` in order to
// explain why they are not one, and a guard that fired on that explanation would
// be deleted.
function classNameExpression(tag: string): { literal: boolean; text: string } {
  const at = tag.indexOf("className=");
  if (at < 0) throw new Error("tag carries no className");
  let i = at + "className=".length;
  if (tag[i] === '"') {
    const end = tag.indexOf('"', i + 1);
    if (end < 0) throw new Error("unterminated className string");
    return { literal: true, text: tag.slice(i + 1, end) };
  }
  if (tag[i] !== "{") throw new Error("unrecognised className form");
  let depth = 0;
  const start = i;
  for (; i < tag.length; i += 1) {
    if (tag[i] === "{") depth += 1;
    else if (tag[i] === "}") {
      depth -= 1;
      if (depth === 0) return { literal: false, text: tag.slice(start + 1, i) };
    }
  }
  throw new Error("unterminated className expression");
}

// Module-scope `const NAME = …;` in the SAME file, substituted into an
// expression. Bounded passes, so a cycle dies on the limit instead of hanging.
function substituteModuleConsts(source: string, expression: string): string {
  let out = expression;
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const m of source.matchAll(
      /^const ([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);$/gm
    )) {
      const token = new RegExp(`(?<![\\w$])${m[1]}(?![\\w$])`, "g");
      if (token.test(out)) {
        out = out.replace(token, `(${m[2]})`);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

// An identifier is allowed to REMAIN in an expression only where it cannot
// contribute class text — a ternary test, a logical operand, a comparison, a
// member base. Anything else (a bare `{LINK_CLASS}`, a `cn(...)` call, a
// `props.className`) is text this scan cannot read.
const IDENTIFIER_IN_CONDITION =
  /^\s*(\?|&&|\|\||===|!==|==|!=|>=|<=|>|<|\)|,|\.)/;
const NOT_A_VALUE = new Set(["true", "false", "null", "undefined"]);

// THE CLASS TEXT A BROWSER WOULD ACTUALLY SEE — or a THROWN error.
//
// This is the shape the whole class-B check turns on, and the reason it is not
// simply "return whatever sits in the className slot". An ABSENCE assertion over
// UNRESOLVED text FAILS OPEN: `hasClass(x, "card") === false` is satisfied by any
// text that does not literally contain `card`, and a bare identifier qualifies.
// So extracting a long className to a module-scope const — the most routine edit
// in this codebase — silently blinded this guard and BOTH card-in-card nests
// could be restored with the whole suite green. Anchoring on the tag did not help:
// the hole was never the anchor, it was reading text nobody had resolved.
//
// Note the asymmetry, because it is why this went unnoticed: a PRESENCE assertion
// over the same unresolved text fails LOUDLY (the `p-0!` premise below died on
// exactly this refactor, naming the identifier it could not read). Only absence
// fails open, and absence is what class B is made of.
//
// So: resolve same-file consts, then read only literal text — and if anything is
// left that could contribute class text and cannot be read, THROW. A red saying
// "make this className readable" is the correct outcome; a green is not.
function classTextOf(source: string, needle: string): string {
  const expression = classNameExpression(openingTagWith(source, needle));
  if (expression.literal) return expression.text;
  return readClassText(substituteModuleConsts(source, expression.text), needle);
}

function readClassText(expression: string, needle: string): string {
  const parts: string[] = [];
  let residue = "";
  let i = 0;
  while (i < expression.length) {
    const c = expression[i];
    if (c === '"' || c === "'") {
      const end = expression.indexOf(c, i + 1);
      if (end < 0)
        throw new Error(`unterminated string in ${needle}'s className`);
      parts.push(expression.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let chunk = "";
      while (j < expression.length && expression[j] !== "`") {
        if (expression[j] === "$" && expression[j + 1] === "{") {
          parts.push(chunk);
          chunk = "";
          let depth = 1;
          let k = j + 2;
          for (; k < expression.length && depth > 0; k += 1) {
            if (expression[k] === "{") depth += 1;
            else if (expression[k] === "}") depth -= 1;
          }
          // Recurse: a hole's own residue is checked by the same rules.
          parts.push(readClassText(expression.slice(j + 2, k - 1), needle));
          j = k;
          continue;
        }
        chunk += expression[j];
        j += 1;
      }
      if (j >= expression.length)
        throw new Error(
          `unterminated template literal in ${needle}'s className`
        );
      parts.push(chunk);
      i = j + 1;
      continue;
    }
    residue += c;
    i += 1;
  }

  for (const m of residue.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (NOT_A_VALUE.has(m[0])) continue;
    const after = residue.slice(m.index + m[0].length);
    if (IDENTIFIER_IN_CONDITION.test(after)) continue;
    throw new Error(
      `${needle}'s className cannot be read: \`${m[0]}\` may contribute class text and this scan cannot resolve it. ` +
        "An absence assertion over unresolved text FAILS OPEN — it would pass while the class it forbids was present. " +
        "Inline the classes, or declare the const at module scope in this same file."
    );
  }
  return parts.join(" ");
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
  // The stack the /longevity seam collapses against. Censused because an
  // un-stepped stack beside a stepped seam renders the LARGER of the two, so this
  // line is load-bearing for a margin declared two files away.
  ["app/(app)/longevity/page.tsx", "section-stack-sm", "space-y-6"],
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

  // The resolver itself, because every absence assertion in this file rests on it
  // and an absence assertion over text nobody resolved passes while the thing it
  // forbids is present. Forged sources, both directions.
  it("class text is RESOLVED or the read THROWS — an absence check may never pass on text it cannot read", () => {
    const tag = (className: string, extra = "") =>
      `${extra}\n<div data-testid="probe" className=${className} />`;

    // READABLE: the value is literal text, wherever it comes from.
    expect(classTextOf(tag('"card p-4"'), 'data-testid="probe"')).toContain(
      "card"
    );
    expect(
      classTextOf(tag('{`card ${x ? "a" : "b"}`}'), 'data-testid="probe"')
    ).toContain("card");
    // …including a same-file module const, which is the refactor that blinded
    // this guard: BOTH card-in-card nests were restorable with the suite green.
    expect(
      classTextOf(
        tag("{LINK_CLASS}", 'const LINK_CLASS =\n  "card subpanel-inset p-4";'),
        'data-testid="probe"'
      )
    ).toContain("card");
    // A ternary's branches are BOTH in scope — for an absence check the union is
    // the conservative direction.
    expect(
      classTextOf(tag('{cond ? "card" : "p-4"}'), 'data-testid="probe"')
    ).toContain("card");

    // UNREADABLE: each of these must THROW rather than return text that happens
    // not to contain the forbidden class.
    const unreadable = [
      [
        "{LINK_CLASS}",
        "a const this file cannot see (imported, or declared in a scope)",
      ],
      ['{cn("flex", styles.card)}', "a helper call"],
      ["{props.className}", "a prop"],
      ["{`flex ${styles.wrapper}`}", "a member expression inside a hole"],
      ["{makeClass()}", "a factory"],
    ];
    for (const [expression, why] of unreadable) {
      expect(
        () => classTextOf(tag(expression), 'data-testid="probe"'),
        `${expression} (${why}) must THROW — an absence assertion over it would pass while the class was present`
      ).toThrow(/cannot be read/);
    }
  });

  it("the two card-in-card nests draw one border each (#3466 class B)", () => {
    // /data mounts IntegrationsGrid — itself a grid of `.card`s — so its wrapper
    // may not be one. Read off the WRAPPER'S OWN tag, located by its id: the page
    // has many legitimate cards.
    const dataPage = read("app/(app)/data/page.tsx");
    expect(
      hasClass(classTextOf(dataPage, 'id="integrations"'), "card"),
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
      hasClass(classTextOf(link, 'data-testid="sync-history-link"'), "card"),
      "IntegrationSyncHistoryLink may not hardcode `card` on itself — every host it has mounts it inside one"
    ).toBe(false);
  });
});
