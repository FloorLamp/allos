import { test, expect } from "@playwright/test";

// Compare-tab axis policy (issue #400). The tab copy promises "Different units
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
test.describe("Compare tab axis policy", () => {
  test("same-unit series share one axis (#400)", async ({ page }) => {
    await page.goto(
      "/trends?tab=compare&cmpA=metric:weight&cmpB=metric:volume"
    );
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "shared");
  });

  test("different-unit series keep the dual axis (#400)", async ({ page }) => {
    await page.goto(
      "/trends?tab=compare&cmpA=metric:weight&cmpB=metric:resting_hr"
    );
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "dual");
  });

  test("normalize collapses to a single shared axis (#400)", async ({
    page,
  }) => {
    await page.goto(
      "/trends?tab=compare&cmpA=metric:weight&cmpB=metric:resting_hr&cmpn=1"
    );
    const chart = page.getByTestId("compare-chart");
    await expect(chart).toBeVisible();
    await expect(chart).toHaveAttribute("data-axis-mode", "shared");
  });
});
