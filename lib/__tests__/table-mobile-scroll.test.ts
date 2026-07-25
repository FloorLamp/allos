import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static data-accessibility guard for wide tables on phones (issue #794, cluster 6).
// The app's main content is `overflow-x-clip`, so a table wider than the viewport
// SILENTLY CLIPS its rightmost columns on a narrow screen — the data is simply
// unreachable, no scrollbar, no hint. The fix is wrap-and-scroll: every `<table>`
// lives inside a horizontal-scroll container so overflow becomes a swipe, not a
// clip. Three markers satisfy that container:
//   - `overflow-x-auto` — the plain wrapper `<div className="overflow-x-auto">`.
//   - `overflow-auto`    — the `max-h-[…] overflow-auto` wrappers (scroll both axes,
//                          used where a tall table also wants a sticky header).
//   - `<ScrollFade>`     — components/ScrollFade.tsx, itself an `overflow-x-auto`
//                          container that additionally fades the scrollable edge.
//   - `<ResponsiveTable>`— components/ResponsiveTable.tsx (issue #1426): the table
//                          stops being a table below `sm` and stacks as cards over
//                          the SAME DOM, so there is no horizontal overflow left to
//                          scroll. A stronger answer than wrap-and-scroll, not a
//                          weaker one — sideways-swiping a data table on a phone
//                          hides the columns that matter even when it "works".
// This reads the repo's own JSX as TEXT (no DB, no browser, so it stays "pure" in
// the vitest sense) and fails the build if any component that renders a `<table>`
// lacks a scroll container in the same file. The check is a per-file string
// heuristic (a file with multiple tables must wrap them all) — coarse but enough
// to catch a newly-added unwrapped table, which is the regression it guards.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for rendered UI source.
const SCAN_DIRS = ["app", "components"];

// Markers that give a `<table>` a working narrow-viewport strategy: a
// horizontal-scroll container, or the card-stacking primitive that removes the
// horizontal axis altogether.
const SCROLL_MARKERS =
  /overflow-x-auto|overflow-auto|<ScrollFade\b|<ResponsiveTable\b/;

// Files allowed to render a `<table>` without any of those markers because they use
// a DIFFERENT, deliberate narrow-viewport strategy:
//  - components/ResponsiveTable.tsx IS the card-stacking primitive — it emits the
//    `<table className="table-cards">` the CSS re-lays as cards below `sm`, so it
//    can't be asked to wrap itself in a scroller.
// (components/BiomarkersTable.tsx used to live here as a column-hider — hiding
// Panel/Notes/Category below `md`. It now renders through <ResponsiveTable> (#1426),
// so those columns come BACK on a phone as card meta lines instead of being dropped.)
const ALLOWLIST = new Set<string>(["components/ResponsiveTable.tsx"]);

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

describe("wide-table mobile scroll boundary (issue #794 cluster 6)", () => {
  it("every rendered <table> sits inside a horizontal-scroll container (or a deliberate column-hider)", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (!/<table\b/.test(text)) continue;
      if (ALLOWLIST.has(rel)) continue;
      if (!SCROLL_MARKERS.test(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files render a <table> with no narrow-viewport strategy, so wide ` +
        `columns clip silently on a phone. Render it through <ResponsiveTable> ` +
        `(it stacks as cards below sm — #1426), wrap it in ` +
        `<div className="overflow-x-auto"> (or <ScrollFade>), or — if it hides ` +
        `columns responsively instead — allowlist it here:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted file still exists and renders a table", () => {
    for (const rel of ALLOWLIST) {
      const abs = path.join(REPO, rel);
      expect(fs.existsSync(abs), `${rel} is allowlisted but missing`).toBe(
        true
      );
      expect(/<table\b/.test(fs.readFileSync(abs, "utf8"))).toBe(true);
    }
  });
});
