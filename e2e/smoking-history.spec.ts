import { test, expect } from "@playwright/test";

// Structured smoking history on Medical → Background (issue #83). Runs authenticated
// as admin acting as the seeded profile 1 (shared storageState). Profile 1 is a
// ~40-year-old, so setting a smoking status does NOT trip the age-gated lung / AAA
// screening rules (50–80 / 65–75) — no Upcoming items are created, so this spec
// can't pollute the shared preventive-care specs. It still resets the field to
// "Not recorded" at the end to leave the fixture as it found it.
test.describe("smoking history (issue #83)", () => {
  test("records status + pack-years + quit year and persists across reloads", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/care/overview");

    const card = page.getByTestId("smoking-history");
    await expect(card).toBeVisible();
    // Privacy copy is stated in the UI (issue #83).
    await expect(card).toContainText("Privacy");

    // Pack-years / quit year are hidden until an ever-smoker status is chosen.
    await expect(page.getByTestId("smoking-pack-years")).toHaveCount(0);

    // Choose "Former smoker" → the quantitative fields appear.
    await page.getByTestId("smoking-status").selectOption("former");
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic
    await expect(page.getByTestId("smoking-pack-years")).toBeVisible();
    await expect(page.getByTestId("smoking-quit-year")).toBeVisible();

    // Enter pack-years and a quit year; blur autosaves each.
    await page.getByTestId("smoking-pack-years").fill("22");
    await page.getByTestId("smoking-pack-years").blur();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic
    await page.getByTestId("smoking-quit-year").fill("2016");
    await page.getByTestId("smoking-quit-year").blur();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic

    // Reload — the structured record round-trips from profile_settings.
    await page.reload();
    await expect(page.getByTestId("smoking-status")).toHaveValue("former");
    await expect(page.getByTestId("smoking-pack-years")).toHaveValue("22");
    await expect(page.getByTestId("smoking-quit-year")).toHaveValue("2016");

    // Reset to "Not recorded" — clears the record and hides the fields, leaving the
    // shared fixture as we found it.
    await page.getByTestId("smoking-status").selectOption("");
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic
    await expect(page.getByTestId("smoking-pack-years")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("smoking-status")).toHaveValue("");
  });
});
