import { test, expect } from "@playwright/test";

// Food–drug interaction guidance (issue #154). The seed gives profile 1 a synthetic
// active Simvastatin (rxcui-keyed) — a CYP3A4 statin — so the medication's detail page
// must show a per-item food-guidance line about grapefruit, with no second medication
// needed. In the #817 redesign FoodGuidance moved off the scannable list rows onto the
// /medications/[id] clinical-record detail page (the med's home), so these open the
// detail from the row. The finding is a formatter over the pure matcher shared by the
// item form and the dose reminder. The seed shares the DB with other specs, so we
// filter to the distinctive guidance text.

// Open one medication's detail page from its list row. The row link is a real anchor,
// so navigation is reliable even before hydration.
async function openMedDetail(
  page: import("@playwright/test").Page,
  name: string
) {
  await page.goto("/medications");
  const link = page
    .getByTestId("medication-row")
    .filter({ hasText: name })
    .first()
    .getByTestId("medication-row-link");
  await expect(link).toBeVisible();
  // Ride out the hydration window (#730): if the first tap lands before the row
  // hydrates it may not navigate, so retry until the detail page shows.
  await expect(async () => {
    await link.click();
    await expect(page.getByTestId("medication-detail")).toBeVisible({
      timeout: 2000,
    });
  }).toPass();
}

test("shows the seeded Simvastatin grapefruit food-drug guidance on the detail page", async ({
  page,
}) => {
  await openMedDetail(page, "Simvastatin");
  const detail = page.getByTestId("medication-detail");

  // Its food-guidance line names the food and the advice — pick the grapefruit
  // guidance by text (the med may carry other food-guidance rows).
  const guidance = detail
    .getByTestId("food-guidance")
    .filter({ hasText: "grapefruit" })
    .first();
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Grapefruit");
  await expect(guidance).toContainText("statin blood levels");
});

test("shows the seeded Warfarin vitamin-K food-drug guidance on the detail page", async ({
  page,
}) => {
  await openMedDetail(page, "Warfarin");
  const detail = page.getByTestId("medication-detail");

  // Warfarin (active in the seed) carries two food notes — vitamin K and alcohol.
  const guidance = detail
    .getByTestId("food-guidance")
    .filter({ hasText: "vitamin K" })
    .first();
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("warfarin works");
});
