import { test, expect } from "@playwright/test";

// Supplement stack-total UL warning (issue #148). The seed gives profile 1 a
// two-product magnesium stack — Magnesium Glycinate 400 mg + Magnesium Citrate
// 200 mg = 600 mg elemental/day — which exceeds the 350 mg supplemental Tolerable
// Upper Intake Level. The Supplements tab must surface an informational warning row that
// sums the stack and names the UL. Read-only against seeded data (nothing to
// clean up); assertions are scoped to the page's main region.

test("shows a stack-total UL warning for an over-UL magnesium stack", async ({
  page,
}) => {
  await page.goto("/nutrition?tab=supplements");
  const main = page.getByRole("main");

  const warning = main.getByTestId("ul-warning-magnesium");
  await expect(warning).toBeVisible();
  // The summed total (600 mg), the UL (350 mg), and the informational framing.
  await expect(warning).toContainText("Magnesium above the upper limit");
  await expect(warning).toContainText("600 mg");
  await expect(warning).toContainText("350 mg");
  await expect(warning).toContainText("discuss with your clinician");
  // Names both contributing products (the stack-total, not a single item).
  await expect(warning).toContainText("Magnesium Glycinate");
  await expect(warning).toContainText("Magnesium Citrate");
});
