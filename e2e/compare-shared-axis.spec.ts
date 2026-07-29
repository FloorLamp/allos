import { test, expect } from "./fixtures";
// Compare axis policy (issue #400) — RE-POINTED to the Insights tab by #1489,
// which folded Compare out of a tab of its own into a section of Insights. Same
// layer, same params, same fixtures; only the ?tab= name changed (?tab=compare
// still resolves here through the alias — see trends-compare-fold.mobile.spec.ts).
// The section copy promises "Different units
// get their own axis"; the code used to render a second, independently
// auto-scaled Y axis for ANY non-normalized pair — so two same-unit series (LDL
// vs HDL, both mg/dL) got two contradictory scales and appeared to cross. The fix:
// same-unit pairs share ONE axis whose domain spans both; only genuinely
// different units get the dual axis. The chart exposes `data-axis-mode` so this
// is assertable without probing recharts SVG internals.
//
// Fixtures: the seed plants weekly body_metrics (weight in kg, resting HR in bpm)
// plus workout volume (kg). weight vs volume share the weight unit; weight vs
// resting HR do not.
test.describe("Compare axis policy", () => {
  test("same-unit series share one axis (#400)", async ({ page }) => {
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:volume");
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "shared");
  });

  test("different-unit series keep the dual axis (#400)", async ({ page }) => {
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:resting_hr");
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "dual");
  });

  test("normalize collapses to a single shared axis (#400)", async ({
    page,
  }) => {
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:resting_hr&cmpn=1");
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "shared");
  });

  // Issue #402: the date axis is time-scaled (type=number scale=time), not an
  // index-spaced category axis, so an irregular series' gaps render proportionally.
  test("date axis is time-scaled (#402)", async ({ page }) => {
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:volume");
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-scale", "time");
  });
});

// Chart polish (issue #1445). A >= 2-series chart carries a legend, so identity
// is never color-alone — which is what makes the brand-green/rose pair (ΔE 2.7
// under deuteranopia) legal in the shared palette at all. Asserted here because
// Compare is the app's canonical two-series surface; the legend renders outside
// the recharts tree, so this needs no SVG probing.
test.describe("Chart legend (#1445)", () => {
  test("a two-series compare chart renders a legend naming both series", async ({
    page,
  }) => {
    await page.goto("/trends?cmpA=metric:weight&cmpB=metric:resting_hr");
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();

    const legend = chart.getByTestId("chart-legend");
    await expect(legend).toBeVisible();
    await expect(legend.getByTestId("chart-legend-item")).toHaveCount(2);
    // Labels are the series names in ink, not the raw metric keys.
    await expect(legend).toContainText(/weight/i);
    await expect(legend).toContainText(/resting/i);
  });
});
