import { test, expect } from "@playwright/test";

// Food–drug interaction guidance (issue #154). The seed gives profile 1 a synthetic
// active Simvastatin (rxcui-keyed) — a CYP3A4 statin — so /medicine must show a
// per-item food-guidance line about grapefruit, with no second medication needed.
// The same finding is a formatter over the pure matcher shared by the item form and
// the dose reminder. Assertions are scoped to the page's main region; the seed shares
// the DB with other specs, so we filter to the distinctive grapefruit guidance.

test("shows the seeded Simvastatin grapefruit food-drug guidance on /medicine", async ({
  page,
}) => {
  await page.goto("/medicine");
  const main = page.getByRole("main");

  // The medication card for the seeded statin is present.
  // Exact match: "Simvastatin" also appears in an interaction-warning line and
  // the item's notes paragraph — a substring match strict-mode-fails on 3 nodes.
  await expect(
    main.getByText("Simvastatin", { exact: true }).first()
  ).toBeVisible();

  // Its food-guidance line names the food and the advice — pick the grapefruit
  // guidance by text (the seed has other food-guidance rows, e.g. warfarin).
  const guidance = main
    .getByTestId("food-guidance")
    .filter({ hasText: "grapefruit" })
    .first();
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("Grapefruit");
  await expect(guidance).toContainText("statin blood levels");
});

test("shows the seeded Warfarin vitamin-K food-drug guidance on /medicine", async ({
  page,
}) => {
  await page.goto("/medicine");
  const main = page.getByRole("main");

  // Warfarin (active in the seed) carries two food notes — vitamin K and alcohol.
  const guidance = main
    .getByTestId("food-guidance")
    .filter({ hasText: "vitamin K" })
    .first();
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText("warfarin works");
});
