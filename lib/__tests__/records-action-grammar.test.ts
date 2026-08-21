import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One primary action per Records pane (issue #3408, item G).
//
// The rule and the vocabulary it belongs to are in docs/internals/design-system.md §3
// (Control grammar, "one primary per surface"). This is the half of it a scan can
// hold: a PANE draws at most one `btn`-class primary, and everything rarer is a
// secondary, a ⋯ item, or a row affordance.
//
// WHY A GUARD AND NOT JUST A DOC. The Records hub reached ten button species
// without anyone deciding to. Nobody added a tenth; each pane added its own
// first, and there was no place the count was visible. A count is exactly what a
// scan is good at.
//
// ── WHAT COUNTS AS A PRIMARY, AND HOW THE REPO SPELLS IT ────────────────────
//
// Measured, not assumed (2026-08-21). Two spellings, and only two:
//
//   1. `AddEntryPanel` — the rare-cadence entry toggle (#1497). It renders a
//      `btn` internally, so a pane that mounts one has already spent its
//      primary even though the string `btn` never appears in the pane file.
//      This is the spelling EVERY records pane's primary actually uses today, so
//      a guard that only looked for the literal class would have been green
//      against a tree that never used it — the #3325 failure exactly.
//   2. A literal `btn` class token. Written as `className="btn …"` or inside a
//      template literal. `btn-ghost`, `btn-sm` and `btn-danger` are DIFFERENT
//      utilities that merely share a prefix, so the token is matched on a word
//      boundary and those do not count — a secondary is allowed.
//
// ── AND WHERE IT DOES *NOT* APPLY ───────────────────────────────────────────
//
// A FORM's submit button is a primary within its own dialog, not the pane's.
// Every `btn` in the records tree today is exactly that — nine `SubmitButton
// className="btn w-full"` saves inside `*Form.tsx` files — and a guard that
// cried wolf on them would have been deleted within a week, taking the real
// guard with it (#3325's five `ORDER BY … COLLATE NOCASE` neighbours, restated).
//
// ── THE UNIT IS THE PANE, AND IT USED NOT TO BE ─────────────────────────────
//
// This scan counted per FILE and was named "at most one primary per pane". The
// two are not the same thing and the difference hid the only case the rule could
// ever bite: `records/care/overview` is ONE pane — one chip, one route, one
// scroll — that mounts four section files, three of which draw their own
// `AddEntryPanel`. Per file every one of them reported 1 and the sweep was
// green; per pane it is 3. A guard whose unit is finer than its rule cannot see
// a violation of that rule.
//
// So a PANE is now the route: a `page.tsx` under app/(app)/records, plus the
// `*Section.tsx` bodies it imports. Its count is the sum.
//
// WHERE THAT BOUNDARY STOPS, said plainly rather than discovered later. A
// component a section MOUNTS — a row list, a photo strip, a sub-list, a pane
// toolbar — is not read. That is a deliberate limit, not an oversight: following
// imports transitively takes `records/specialty/substance-use` from 1 to 8 by
// reaching `app/(app)/medical/`'s `ConsumptionSection` and `TrackSubstanceControl`,
// whose buttons are that surface's own business. Measured, both ways, before
// choosing the narrow one.
//
// The known cost of the narrow boundary: the Immunizations toolbar this issue
// MOVED — app/(app)/immunizations/ImmunizationRecordActions.tsx and
// MyChartImport.tsx — sits outside it. Both measure ZERO primaries today (they
// are `btn-ghost` and ⋯ items, which is the whole point of item G), so nothing
// is being waved through; but a `btn` appearing there would not turn this red,
// and the next reader should know that rather than infer coverage the scan does
// not have.
const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECORDS_DIR = "app/(app)/records";

// The one STACKED pane, recorded rather than smuggled — the chokepoint-register
// discipline this repo already uses for anatomy exceptions.
//
// `care/overview` is four short sections behind four `<details>` disclosures
// (CareOverviewDisclosure), collapsed on arrival. At most one primary is on
// screen at a time and each names the section it belongs to, so the reading the
// rule protects — "one obvious next action per surface" — holds even though the
// count does not. Every OTHER pane in the tree is flat and gets no such licence,
// and the test below fails if this entry ever stops being needed.
const STACKED_PANE_ALLOW = new Map<string, string>([
  [
    "app/(app)/records/care/overview/page.tsx",
    "four <details> sections, collapsed on arrival: each primary is inside the one section it belongs to and only one is ever on screen",
  ],
]);

// Comment prose says `btn` a lot — this file's own subject matter is buttons —
// so the scan reads code only. Block comments and line comments both.
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// How many pane-level primaries a file draws. Both spellings, deduplicated by
// nothing: two AddEntryPanels IS two primaries, which is the finding.
export function primaryCount(text: string): number {
  const source = withoutComments(text);
  const entryPanels = source.match(/<AddEntryPanel\b/g)?.length ?? 0;
  // The word boundary is what keeps `btn-ghost` out. `[\w-]` on both sides so a
  // hyphenated sibling utility cannot match at either end.
  const literal = source.match(/(?<![\w-])btn(?![\w-])/g)?.length ?? 0;
  return entryPanels + literal;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function readRel(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function relOf(full: string): string {
  return path.relative(REPO, full).split(path.sep).join("/");
}

// Resolve one import specifier to a repo-relative `.tsx` path, or null. Only the
// two spellings the records tree uses: a relative path, and the `@/` alias.
export function resolveImport(spec: string, fromRel: string): string | null {
  let cand: string;
  if (spec.startsWith("@/")) cand = spec.slice(2);
  else if (spec.startsWith(".")) {
    cand = path
      .normalize(path.join(path.dirname(fromRel), spec))
      .split(path.sep)
      .join("/");
  } else return null;
  const withExt = cand.endsWith(".tsx") ? cand : `${cand}.tsx`;
  return fs.existsSync(path.join(REPO, withExt)) ? withExt : null;
}

// The `*Section.tsx` bodies a route mounts. Import specifiers only — no module
// graph, no bundler — because that is all this needs and a parser here would be
// a second thing to keep true.
export function sectionsOf(pageRel: string, text: string): string[] {
  const specs = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  return specs
    .map((spec) => resolveImport(spec, pageRel))
    .filter((rel): rel is string => !!rel && rel.endsWith("Section.tsx"));
}

// Every pane in the tree: its route file, the section bodies it mounts, and the
// primaries they draw between them.
function panes(): { rel: string; members: string[]; count: number }[] {
  const abs = path.join(REPO, RECORDS_DIR);
  return walk(abs)
    .map(relOf)
    .filter((rel) => rel.endsWith("/page.tsx"))
    .sort()
    .map((rel) => {
      const text = readRel(rel);
      const members = sectionsOf(rel, text);
      const count =
        primaryCount(text) +
        members.reduce((n, m) => n + primaryCount(readRel(m)), 0);
      return { rel, members, count };
    });
}

describe("Records action grammar (#3408)", () => {
  it("scans a non-empty set of panes", () => {
    // A scan over nothing is green and says nothing. This is the check that the
    // directory walk still finds the panes after a route move.
    const found = panes();
    expect(found.length).toBeGreaterThan(10);
  });

  it("resolves a pane's sections, not just its route file", () => {
    // THE UNIT ITSELF, ASSERTED. Everything below is a count over `panes()`, and
    // a `panes()` that silently resolved no sections would report 0 for every
    // route and sweep green forever — the failure mode that let the per-file
    // version ship. So two known shapes are pinned by name: the stacked pane
    // must resolve its four sections, and a flat one must resolve its single
    // section rather than an empty list.
    const byRel = new Map(panes().map((p) => [p.rel, p]));

    const overview = byRel.get("app/(app)/records/care/overview/page.tsx")!;
    expect(overview.members.sort()).toEqual([
      "app/(app)/records/BackgroundSection.tsx",
      "app/(app)/records/CarePlanSection.tsx",
      "app/(app)/records/FamilyHistorySection.tsx",
      "app/(app)/records/HealthGoalsSection.tsx",
    ]);
    expect(overview.count).toBe(3);

    const visits = byRel.get("app/(app)/records/history/visits/page.tsx")!;
    expect(visits.members).toEqual(["app/(app)/records/VisitsSection.tsx"]);
    expect(visits.count).toBe(1);
  });

  it("leaves no section body unclaimed by a pane", () => {
    // A Section the scan reaches through no route is a Section nothing counts.
    // The per-file version could not have this problem and the per-pane version
    // can, so it is checked rather than assumed: every `*Section.tsx` under
    // app/(app)/records is mounted by at least one `page.tsx`.
    const claimed = new Set(panes().flatMap((p) => p.members));
    const all = walk(path.join(REPO, RECORDS_DIR))
      .map(relOf)
      .filter((rel) => rel.endsWith("Section.tsx"));
    const orphans = all.filter((rel) => !claimed.has(rel));
    expect(
      orphans,
      "These section bodies are mounted by no Records route, so no pane count " +
        "includes them and the action-grammar rule is unenforced over them:\n" +
        orphans.map((o) => `  ${o}`).join("\n")
    ).toEqual([]);
  });

  it("draws at most one primary per pane", () => {
    const offenders = panes().filter(
      (p) => p.count > 1 && !STACKED_PANE_ALLOW.has(p.rel)
    );

    expect(
      offenders.map((o) => o.rel),
      "A Records pane draws at most ONE `btn`-class primary (docs/internals/" +
        "design-system.md §3, 'Control grammar'). A second candidate is a secondary " +
        "(`btn-ghost`), a `⋯` item (components/OverflowMenu.tsx), or a row " +
        "affordance — or one of the two is not actually primary. A pane that " +
        "genuinely stacks collapsed sections belongs in STACKED_PANE_ALLOW with " +
        "its reason, not in a widened count. Offenders:\n" +
        offenders
          .map((o) => `  ${o.rel}: ${o.count} (${o.members.join(", ")})`)
          .join("\n")
    ).toEqual([]);
  });

  it("keeps no stale entry in the stacked-pane register", () => {
    // An exception that has stopped being needed is an exception nobody will
    // re-examine. If `care/overview` ever flattens to one primary, this fails and
    // the entry comes out.
    const byRel = new Map(panes().map((p) => [p.rel, p]));
    for (const [rel, reason] of STACKED_PANE_ALLOW) {
      const pane = byRel.get(rel);
      expect(pane, `${rel} is registered but is no longer a pane`).toBeTruthy();
      expect(
        pane!.count,
        `${rel} no longer needs its exception (${reason})`
      ).toBeGreaterThan(1);
    }
  });

  it("stays silent on a form's own submit button", () => {
    // THE BENIGN NEIGHBOUR, asserted rather than assumed. Every `btn` in the
    // records tree today is a form save, and a guard that flagged them would be
    // deleted within a week. A form is neither a route nor a `*Section.tsx`, so
    // no pane's member list can contain one — proved here against a real form
    // that WOULD trip the count if it were ever read.
    const formRel = "app/(app)/records/problems/allergies/AllergyForm.tsx";
    expect(primaryCount(readRel(formRel))).toBeGreaterThan(0);
    expect(panes().flatMap((p) => p.members)).not.toContain(formRel);
  });

  it("can see both spellings, and neither sibling utility", () => {
    // THE GUARD RUN OVER SOURCES AUTHORED TO BREAK IT. A green sweep over a
    // complying tree says nothing about what the sweep can see.
    expect(
      primaryCount(
        `<AddEntryPanel label="Add" /><AddEntryPanel label="Also" />`
      )
    ).toBe(2);
    expect(primaryCount(`<button className="btn">A</button>`)).toBe(1);
    expect(primaryCount("const c = `btn ${wide ? 'w-full' : ''}`;")).toBe(1);
    expect(
      primaryCount(`<AddEntryPanel /><button className="btn w-full" />`)
    ).toBe(2);

    // The sibling utilities are a DIFFERENT species and stay allowed.
    expect(primaryCount(`<a className="btn-ghost">Import</a>`)).toBe(0);
    expect(primaryCount(`<button className="btn-danger" />`)).toBe(0);
    expect(primaryCount(`<button className="my-btn-thing" />`)).toBe(0);

    // And the word in prose is not a button. This file's own header would
    // otherwise register a dozen primaries.
    expect(primaryCount(`// a full \`btn\` primary per pane\n`)).toBe(0);
    expect(primaryCount(`/* className="btn" in a block comment */`)).toBe(0);
  });
});
