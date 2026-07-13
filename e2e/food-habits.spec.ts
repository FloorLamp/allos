import { test, expect } from "@playwright/test";

// Food-habit targets (issue #580): the /nutrition Weekly habits card shows a food_group
// frequency target with its #579-rollup progress, and a new habit can be tracked/removed.
// The seed plants a "fatty fish 2×/week" habit. Idempotent — the tracked-then-removed
// habit leaves the fixture as found.

test("Weekly habits shows the seeded fatty-fish target with progress (#580)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const card = page.getByTestId("weekly-habits");
  await expect(card).toBeVisible();
  await expect(page.getByTestId("habit-fatty_fish")).toBeVisible();
  // "N / 2" plus an On track / Behind badge.
  await expect(page.getByTestId("habit-fatty_fish")).toContainText("/ 2");
});

test("tracking a new food habit adds it, and removing it leaves the fixture as found (#580)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // Track "Legumes & beans" as a weekly habit.
  await page
    .getByTestId("add-habit-form")
    .getByLabel("Food group")
    .selectOption("legumes");
  await page.getByRole("button", { name: "Track" }).click();

  await expect(page.getByTestId("habit-legumes")).toBeVisible();

  // Remove it (leave as found).
  await page
    .getByTestId("habit-legumes")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  await expect(page.getByTestId("habit-legumes")).toHaveCount(0);
});
