import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The drag-transform convention (issue #1891), in the repo's established
// source-scan idiom (`icon-button-tooltip-scan.test.ts`, `chart-colors-scan.test.ts`):
// read the app's own TSX as TEXT — no DB, no browser, so it stays "pure" — and fail
// the build when a `useSortable` consumer applies dnd-kit's transform WHOLE.
//
// ── why ──────────────────────────────────────────────────────────────────────
//
// A sorting strategy's transform is not just a translation. `rectSortingStrategy`
// returns `scaleX`/`scaleY` alongside `x`/`y`, sized so the moving item morphs
// toward the dimensions of the slot it is currently passing over. Where the items
// are uniform — the Trends Overview's equal-width, row-height-matched tiles — that
// scale is ~1 and nobody ever saw it. The dashboard's Customize cards vary wildly
// in height, so the SAME code visibly squashed and stretched the card being
// dragged, which is what the owner reported.
//
// `CSS.Transform.toString()` emits `translate3d(…) scaleX(…) scaleY(…)`.
// `CSS.Translate.toString()` emits the translate3d only. A reorder never needs
// more than that: the item is moving, not resizing.
//
// This is the STRUCTURAL PIN the issue asks for. The distortion itself is a
// rendered detail of a gesture in flight — hard to assert honestly in a browser
// test — but "which of the two helpers does the sortable style call" is exactly
// the decision that produced it, and it is right here in the source.
//
// A consumer that opts into a `DragOverlay` for its lift satisfies the same intent
// (the overlay is measured once from the lifted node's rect and never rescaled),
// so the check is: translate-only, or an overlay, and in practice both.

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const ROOTS = ["app", "components"];

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...tsxFiles(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sortableConsumers(): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = [];
  for (const r of ROOTS) {
    for (const file of tsxFiles(path.join(root, r))) {
      const source = fs.readFileSync(file, "utf8");
      if (/\buseSortable\s*\(/.test(source)) {
        found.push({ file: path.relative(root, file), source });
      }
    }
  }
  return found;
}

describe("sortable items translate, they do not scale (#1891)", () => {
  const consumers = sortableConsumers();

  // The sweep must not be able to pass by finding nothing. Both known consumers —
  // the dashboard's Customize grid and the Trends Overview's starred tiles — are
  // named, so deleting or renaming one is a deliberate edit here rather than a
  // silent loss of coverage.
  it("finds every useSortable consumer", () => {
    expect(consumers.map((c) => c.file).sort()).toEqual([
      "components/SavedTilesGrid.tsx",
      "components/dashboard/DashboardGrid.tsx",
    ]);
  });

  it.each(consumers.map((c) => c.file))(
    "%s applies the translation only",
    (file) => {
      const source = consumers.find((c) => c.file === file)!.source;
      expect(
        source.includes("CSS.Transform"),
        `${file} applies dnd-kit's full transform, which carries scaleX/scaleY and ` +
          `distorts an item whose neighbours are a different size. Use ` +
          `CSS.Translate.toString(transform).`
      ).toBe(false);
      expect(
        source.includes("CSS.Translate.toString("),
        `${file} uses useSortable but never positions the item with ` +
          `CSS.Translate.toString(transform).`
      ).toBe(true);
    }
  );
});
