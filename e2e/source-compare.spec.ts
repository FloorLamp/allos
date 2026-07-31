import { test, expect } from "./fixtures";
// Multi-source metric comparison (issue #14). seed-events.ts plants five nights
// of HRV from BOTH Health Connect and Oura, so the HRV detail page must render
// the "Compare sources" section with a per-source overlay and a primary-source
// picker that persists the choice into the profile's settings.
test.describe("multi-source metric comparison", () => {
  test("the metric detail page renders a per-source overlay for a two-source metric", async ({
    page,
  }) => {
    await page.goto("/trends/metric/hrv");
    const section = page.getByTestId("source-comparison");
    await expect(section).toBeVisible();

    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Heart rate variability",
      })
    ).toBeVisible();
    await expect(page.getByTestId("source-compare-hrv_ms")).toBeVisible();

    // Legend names both sources — identity is never color-alone.
    const legend = section.getByTestId("source-legend-hrv_ms");
    await expect(legend).toContainText("Google Health Connect");
    await expect(legend).toContainText("Oura Ring");

    // The picker offers Automatic plus each reporting source.
    const picker = section.getByTestId("primary-source-hrv_ms");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(""); // automatic by default

    // Comparison is scoped to the selected window. A narrow range with no
    // readings must not advertise historical sources in its picker or legend.
    const sevenDayHref = await page
      .getByRole("link", { name: "7D", exact: true })
      .getAttribute("href");
    expect(sevenDayHref).not.toBeNull();
    const today = new URL(sevenDayHref!, page.url()).searchParams.get("to");
    expect(today).not.toBeNull();
    await page.goto(`/trends/metric/hrv?from=${today}&to=${today}`);
    await expect(page.getByTestId("source-comparison")).toHaveCount(0);
  });

  test("active calories has its own detailed chart and source controls", async ({
    page,
  }) => {
    await page.goto("/trends/metric/active-calories");

    await expect(
      page.getByRole("heading", { level: 1, name: "Active Calories" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("primary-source-active_kcal")).toBeVisible();
    await expect(page.getByTestId("metric-readings")).toBeVisible();
  });

  test("picking a primary source persists across a reload", async ({
    page,
  }) => {
    await page.goto("/trends/metric/hrv");
    const picker = page.getByTestId("primary-source-hrv_ms");
    await expect(picker).toBeVisible();

    // Selecting fires the server action; the picker shows "Saved" only after
    // the action resolves, so waiting on it makes the write durable before the
    // reload (a bare POST-wait can race unrelated page-load posts).
    await picker.selectOption("oura");
    await expect(page.getByTestId("primary-source-saved-hrv_ms")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("primary-source-hrv_ms")).toHaveValue("oura");

    // Leave the fixture in its default state for other specs/runs.
    await page.getByTestId("primary-source-hrv_ms").selectOption("");
    await expect(page.getByTestId("primary-source-saved-hrv_ms")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("primary-source-hrv_ms")).toHaveValue("");
  });
});
