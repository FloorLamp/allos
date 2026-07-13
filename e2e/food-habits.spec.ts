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
  // Scoped to the add form: the suggestion cards render their own "Track"
  // buttons (7 on the seeded page), a strict-mode collision unscoped.
  await page
    .getByTestId("add-habit-form")
    .getByRole("button", { name: "Track" })
    .click();

  await expect(page.getByTestId("habit-legumes")).toBeVisible();

  // Remove it (leave as found).
  await page
    .getByTestId("habit-legumes")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  await expect(page.getByTestId("habit-legumes")).toHaveCount(0);
});

test("a food-group habit that conflicts with an active medication carries the interaction note (#661)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // Track leafy greens — the seed has an active Warfarin medication, so the habit
  // should carry the vitamin-K food–drug note (same fact the medication row shows).
  await page
    .getByTestId("add-habit-form")
    .getByLabel("Food group")
    .selectOption("leafy_greens");
  await page
    .getByTestId("add-habit-form")
    .getByRole("button", { name: "Track" })
    .click();

  await expect(page.getByTestId("habit-leafy_greens")).toBeVisible();
  const warning = page.getByTestId("habit-warning-leafy_greens");
  await expect(warning).toBeVisible();
  await expect(warning).toContainText("Warfarin");

  // Remove it (leave the fixture as found).
  await page
    .getByTestId("habit-leafy_greens")
    .getByRole("button", { name: "Stop tracking this habit" })
    .click();
  await expect(page.getByTestId("habit-leafy_greens")).toHaveCount(0);
});
