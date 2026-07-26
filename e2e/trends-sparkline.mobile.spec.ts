import { test, expect } from "./fixtures";
// True sparkline mode for Overview/Body mini tiles (issue #1445, Part 2,
// owner-added from mobile-vitals feedback).
//
// `TrendMiniCard` called itself a sparkline while rendering the FULL
// `LineChartCard`, so every tile carried a complete X+Y axis — 11px ticks and
// margins sized for a 256px-tall chart — inside a ~150px-wide tile on a 390px
// phone. The ticks collided and the plot got what was left. The variant hides
// both axes (they still SCALE the series; they stop painting themselves and stop
// reserving space) and renders the numbers they were there to supply as inline
// text.
//
// This is a mobile-viewport spec (390x844, the `mobile` project) because tile
// width is the whole point: at 1280px the old chrome fit, which is exactly why
// the defect survived a desktop-only suite.
//
// Fixtures: the seeded Body-tab `weight` tile and the `weight` metric detail
// page — both targeted by exact locators (a per-metric testid; the detail page
// renders exactly one chart) rather than by position on a shared grid.
test.describe("Trends mini-tile sparkline (#1445)", () => {
  test("a mini tile draws a sparkline with no axis chrome, and states its range as text", async ({
    page,
  }) => {
    await page.goto("/trends?tab=body");

    const tile = page.getByTestId("body-tile-weight");
    await expect(tile).toBeVisible();

    // The chart renders (recharts is code-split, so this also proves the chunk
    // resolved at phone width).
    const svg = tile.locator("svg.recharts-surface");
    await expect(svg).toBeVisible();

    // The point of the variant: no axis chrome painted inside the tile. Asserted
    // on the TICK LABELS (and the grid), not on the `.recharts-cartesian-axis`
    // group — recharts 3.x renders that group even for a hidden axis, so counting
    // groups would pass while the labels were still on screen, which is the very
    // defect this spec exists to catch.
    await expect(
      tile.locator(".recharts-cartesian-axis-tick-value")
    ).toHaveCount(0);
    await expect(tile.locator(".recharts-cartesian-grid")).toHaveCount(0);

    // …and the numbers the Y axis used to imply are present as legible text.
    const range = tile.getByTestId("trend-mini-range");
    await expect(range).toBeVisible();
    await expect(range).toContainText(/Low/);
    await expect(range).toContainText(/High/);
  });

  test("a full-size chart keeps its axes at phone width", async ({ page }) => {
    // The counterpart guarantee: hiding axes is the MINI-tile decision, not a
    // global one. A full-size chart still carries the axis a reader traces a
    // value along, and #1445's recessive-axis pass has to hold up at 390px too.
    await page.goto("/trends/metric/weight");

    // The metric detail page renders exactly one chart, so no positional pick.
    const chart = page.locator(".recharts-surface");
    await expect(chart).toBeVisible();
    await expect(
      chart.locator(".recharts-cartesian-axis-tick-value")
    ).not.toHaveCount(0);

    // Ticks stay at or above the 10px legibility floor the scaffold sets.
    const tickSize = await chart
      .locator(".recharts-cartesian-axis-tick-value")
      .first() // first-ok: sampling any one tick — they all come from the same chartAxisProps bag
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(tickSize).toBeGreaterThanOrEqual(10);
  });
});
