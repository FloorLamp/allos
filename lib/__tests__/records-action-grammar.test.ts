import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One primary action per Records pane (issue #3408, item G).
//
// The rule and the vocabulary it belongs to are in docs/internals/appearance.md,
// "Action grammar: one primary per surface". This is the half of it a scan can
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
// So the scan reads PANE files only: the `*Section.tsx` bodies and the pane
// `page.tsx` routes under app/(app)/records.
const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RECORDS_DIR = "app/(app)/records";

// A pane is the thing a chip navigates to: the route file, or the Section
// component the route mounts. A form, a list, a row and a per-field control are
// all things INSIDE a pane and answer to their own rules.
function isPaneFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? "";
  return base === "page.tsx" || base.endsWith("Section.tsx");
}

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

function paneFiles(): { rel: string; text: string }[] {
  const abs = path.join(REPO, RECORDS_DIR);
  return walk(abs)
    .map((full) => ({
      rel: path.relative(REPO, full).split(path.sep).join("/"),
      text: fs.readFileSync(full, "utf8"),
    }))
    .filter((f) => isPaneFile(f.rel));
}

describe("Records action grammar (#3408)", () => {
  it("scans a non-empty set of panes", () => {
    // A scan over nothing is green and says nothing. This is the check that the
    // directory walk still finds the panes after a route move.
    const files = paneFiles();
    expect(files.length).toBeGreaterThan(10);
  });

  it("draws at most one primary per pane", () => {
    const offenders = paneFiles()
      .map((f) => ({ rel: f.rel, count: primaryCount(f.text) }))
      .filter((f) => f.count > 1);

    expect(
      offenders,
      "A Records pane draws at most ONE `btn`-class primary (docs/internals/" +
        "appearance.md, 'Action grammar'). A second candidate is a secondary " +
        "(`btn-ghost`), a `⋯` item (components/OverflowMenu.tsx), or a row " +
        "affordance — or one of the two is not actually primary. Offenders:\n" +
        offenders.map((o) => `  ${o.rel}: ${o.count}`).join("\n")
    ).toEqual([]);
  });

  it("stays silent on a form's own submit button", () => {
    // THE BENIGN NEIGHBOUR, asserted rather than assumed. Every `btn` in the
    // records tree today is a form save, and a guard that flagged them would be
    // deleted within a week. `*Form.tsx` is not a pane, so the scan never reads
    // one — proved here by showing a real form that WOULD trip the count.
    const form = fs.readFileSync(
      path.join(REPO, RECORDS_DIR, "problems/allergies/AllergyForm.tsx"),
      "utf8"
    );
    expect(primaryCount(form)).toBeGreaterThan(0);
    expect(isPaneFile("app/(app)/records/problems/allergies/AllergyForm.tsx")).toBe(
      false
    );
  });

  it("can see both spellings, and neither sibling utility", () => {
    // THE GUARD RUN OVER SOURCES AUTHORED TO BREAK IT. A green sweep over a
    // complying tree says nothing about what the sweep can see.
    expect(
      primaryCount(`<AddEntryPanel label="Add" /><AddEntryPanel label="Also" />`)
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
