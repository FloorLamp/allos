import { test, expect, type Page } from "@playwright/test";
import {
  openMedDetailViaLink,
  foodGuidance,
} from "./med-card-helpers";

// Food–drug interaction guidance (issue #154). The seed gives profile 1 a synthetic
// active Simvastatin (rxcui-keyed) — a CYP3A4 statin — so the medication's detail page
// must show a per-item food-guidance line about grapefruit, with no second medication
// needed. In the #817 redesign FoodGuidance moved off the scannable list rows onto the
// /medications/[id] clinical-record detail page (the med's home), so these open the
// detail from the row. The finding is a formatter over the pure matcher shared by the
// item form and the dose reminder. The seed shares the DB with other specs, so we
// filter to the distinctive guidance text.

// Open one medication's detail page from its list row. The row-link nav (the followLink
// pre-hydration-safe strategy) lives in the shared med-card driver (#868 class-2), so the
// medication-card anatomy is pinned in ONE place.
async function openMedDetail(page: Page, name: string) {
  await page.goto("/medications");
  const detail = await openMedDetailViaLink(page, name);
  await expect(detail).toBeVisible();
  return detail;
}

test("shows the seeded Simvastatin grapefruit food-drug guidance on the detail page", async ({
  page,
}) => {
  const detail = await openMedDetail(page, "Simvastatin");

  // Its food-guidance line names the food and the advice — pick the grapefruit
  // guidance by text (the med may carry other food-guidance rows).
  const guidance = foodGuidance(detail, "grapefruit");
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Grapefruit");
  await expect(guidance).toContainText("statin blood levels");
});

test("shows the seeded Warfarin vitamin-K food-drug guidance on the detail page", async ({
  page,
}) => {
  const detail = await openMedDetail(page, "Warfarin");

  // Warfarin (active in the seed) carries two food notes — vitamin K and alcohol.
  const guidance = foodGuidance(detail, "vitamin K");
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("warfarin works");
});
