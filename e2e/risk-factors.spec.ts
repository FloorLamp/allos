import { test, expect } from "@playwright/test";

// Health risk factors on Medical → Background (issue #517). Runs authenticated as
// admin acting as the seeded profile 1 (shared storageState). Toggling a factor
// changes only the retest/screening cadence + ranking on Upcoming; it creates no
// new preventive items on its own, so this spec can't pollute the shared specs. It
// resets every factor to off at the end to leave the fixture as it found it.
test.describe("health risk factors (issue #517)", () => {
  test("toggles a risk factor and persists it across reloads", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/care/overview");

    const card = page.getByTestId("risk-factors");
    await expect(card).toBeVisible();
    // Privacy copy is stated; the disclaimer moved to /disclaimer (#1049).
    await expect(card).not.toContainText("not medical advice");
    await expect(card).toContainText("Privacy");

    const healthcare = page.getByTestId("risk-healthcare_worker");
    await expect(healthcare).not.toBeChecked();

    // Toggle on → autosaves.
    await healthcare.check();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic

    // Reload — the flag round-trips from profile_settings.
    await page.reload();
    await expect(page.getByTestId("risk-healthcare_worker")).toBeChecked();

    // #553: the factor now ranks up the matching vaccine on the immunization page.
    // Profile 1's seeded influenza (last season's flu, ~13mo old) reads `due`; the
    // healthcare-worker factor elevates it with a calm reason line. Done here,
    // inside the single on→off window, so no other spec sees the mutated factor.
    await page.goto("/records/history/immunizations");
    const flu = page.getByTestId("immunization-prioritized-influenza");
    await expect(flu).toBeVisible();
    await expect(flu).toContainText("Healthcare worker");

    // Reset to off, leaving the shared fixture as we found it.
    await page.goto("/records/care/overview");
    await page.getByTestId("risk-healthcare_worker").uncheck();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic
    await page.reload();
    await expect(page.getByTestId("risk-healthcare_worker")).not.toBeChecked();
  });
});
