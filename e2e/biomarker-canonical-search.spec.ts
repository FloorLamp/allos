import { test, expect } from "@playwright/test";

// #383 — the Biomarkers table free-text search must match the CANONICAL name (the
// row heading a user sees), not only the raw lab string. The e2e fixture
// (e2e/seed-events.ts) plants a record raw-named "E2E CHOLESTEROL, TOTAL" but
// displayed/canonicalized as "E2E Total Cholesterol".
test.describe("biomarker search matches the displayed canonical name (#383)", () => {
  test("finds the row by its canonical heading", async ({ page }) => {
    await page.goto("/biomarkers?q=" + encodeURIComponent("E2E Total Chol"));
    // The row is present, headed by its canonical name (a link to its series).
    await expect(
      page.getByRole("link", { name: "E2E Total Cholesterol", exact: true })
    ).toBeVisible();
  });

  test("still finds the row by the raw lab string", async ({ page }) => {
    await page.goto("/biomarkers?q=" + encodeURIComponent("E2E CHOLESTEROL"));
    await expect(
      page.getByRole("link", { name: "E2E Total Cholesterol", exact: true })
    ).toBeVisible();
  });
});
