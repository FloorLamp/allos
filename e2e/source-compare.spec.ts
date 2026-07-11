import { test, expect } from "@playwright/test";

// Multi-source metric comparison (issue #14). seed-events.ts plants five nights
// of HRV from BOTH Health Connect and Oura, so Trends → Body must render the
// "Compare sources" section with a per-source overlay card for HRV and a
// primary-source picker that persists the choice into the profile's settings.
test.describe("multi-source metric comparison", () => {
  test("the Body tab renders a per-source overlay for a two-source metric", async ({
    page,
  }) => {
    await page.goto("/trends?tab=body");
    const section = page.getByTestId("source-comparison");
    await expect(section).toBeVisible();

    const card = page.getByTestId("source-compare-hrv_ms");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "HRV" })).toBeVisible();

    // Legend names both sources — identity is never color-alone.
    const legend = card.getByTestId("source-legend-hrv_ms");
    await expect(legend).toContainText("Google Health Connect");
    await expect(legend).toContainText("Oura Ring");

    // The picker offers Automatic plus each reporting source.
    const picker = card.getByTestId("primary-source-hrv_ms");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveValue(""); // automatic by default
  });

  test("picking a primary source persists across a reload", async ({
    page,
  }) => {
    await page.goto("/trends?tab=body");
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
