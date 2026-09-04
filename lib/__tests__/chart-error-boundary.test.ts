import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Guard-parity scan (issue #401). Every code-split chart wrapper — a "use client"
// component that lazy-loads its recharts inner via `dynamic(() => import("./…Inner"))`
// and shows a <ChartLoading> placeholder — MUST render that inner inside a
// <ChartErrorBoundary>. A rejected lazy-chunk import (the browser went offline
// before the chunk resolved) otherwise throws to the ROUTE error boundary and
// replaces the whole page, unmounting unrelated UI like the quick-log forms —
// the exact regression ChartErrorBoundary was built to contain. StackedBarCard
// was the one twin that skipped it; this test fails the build if the next chart
// wrapper drifts the same way.
//
// Since #4925 there are THREE seams rather than nine, because the split is one
// per RENDERER: a card is a spec now, and only a renderer loads recharts.
describe("chart wrapper error-boundary parity", () => {
  const componentsDir = join(__dirname, "..", "..", "components");
  const files = readdirSync(componentsDir).filter((f) => f.endsWith(".tsx"));

  // A chart wrapper: it code-splits an inner via next/dynamic AND renders the
  // shared <ChartLoading> spinner while the chunk loads. That pair is the
  // signature every recharts wrapper shares.
  const wrappers = files.filter((f) => {
    const src = readFileSync(join(componentsDir, f), "utf8");
    return (
      /dynamic\(\s*\(\)\s*=>\s*import\("\.\/\w*Inner"\)/.test(src) &&
      src.includes("ChartLoading")
    );
  });

  it("finds the known chart wrappers", () => {
    // Sanity check that the heuristic still matches real files (so a rename or
    // refactor that hides every wrapper can't silently make this test vacuous).
    //
    // THREE, where this said five. #4925 moved the code-split seam from one per
    // CARD to one per RENDERER: nine cards became specs over two renderers plus
    // Scatter, so the population this guard is about genuinely shrank — and the
    // guard caught it, which is the vacuity check working rather than a floor to
    // be lowered on request. The fact is unchanged: every seam that lazy-loads a
    // recharts chunk catches that chunk failing.
    expect(wrappers).toContain("TimeSeriesChart.tsx");
    expect(wrappers).toContain("BarSeriesChart.tsx");
    expect(wrappers).toContain("ScatterChartCard.tsx");
    expect(wrappers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(wrappers)("%s wraps its inner in ChartErrorBoundary", (file) => {
    const src = readFileSync(join(componentsDir, file), "utf8");
    expect(src).toContain("ChartErrorBoundary");
  });
});
