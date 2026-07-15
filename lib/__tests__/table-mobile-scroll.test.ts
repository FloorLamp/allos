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
// This reads the repo's own JSX as TEXT (no DB, no browser, so it stays "pure" in
// the vitest sense) and fails the build if any component that renders a `<table>`
// lacks a scroll container in the same file. The check is a per-file string
// heuristic (a file with multiple tables must wrap them all) — coarse but enough
// to catch a newly-added unwrapped table, which is the regression it guards.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Directories scanned for rendered UI source.
const SCAN_DIRS = ["app", "components"];

// Markers that put a `<table>` inside a horizontal-scroll container.
const SCROLL_MARKERS = /overflow-x-auto|overflow-auto|<ScrollFade\b/;

// Files allowed to render a `<table>` without a scroll wrapper because they use a
// DIFFERENT, deliberate mobile strategy — responsive column-hiding — instead of
// wrap-and-scroll:
//  - components/BiomarkersTable.tsx hides the Panel/Notes/Category columns below
//    `md` (`hidden md:table-cell`) so the remaining columns fit a phone without a
//    horizontal scroll. (It also carries `overflow-auto` for VERTICAL scroll under
//    a sticky header, so it passes the marker check today too; the allowlist keeps
//    it green if that vertical wrapper ever changes, since column-hiding is its
//    load-bearing horizontal strategy.)
const ALLOWLIST = new Set<string>(["components/BiomarkersTable.tsx"]);

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
      `These files render a <table> with no horizontal-scroll wrapper, so wide ` +
        `columns clip silently on a phone. Wrap the table in ` +
        `<div className="overflow-x-auto"> (or <ScrollFade>), or — if it hides ` +
        `columns responsively instead — allowlist it here:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("every allowlisted column-hider still exists and renders a table", () => {
    for (const rel of ALLOWLIST) {
      const abs = path.join(REPO, rel);
      expect(fs.existsSync(abs), `${rel} is allowlisted but missing`).toBe(
        true
      );
      expect(/<table\b/.test(fs.readFileSync(abs, "utf8"))).toBe(true);
    }
  });
});
