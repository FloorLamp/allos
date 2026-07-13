import { test, expect } from "@playwright/test";

// Food-group serving log (issue #579): one-tap logging on /nutrition, the day-view
// count, and the weekly rollup. Idempotent — logs a serving, asserts it appears in both
// the day count and the weekly rollup, then undoes it so the fixture is left as found.
// Uses the shared authenticated storageState (the seeded profile already has food_log
// rows from scripts/seed.ts).

test("logging a serving shows in the day count and the weekly rollup, undo decrements (#579)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  const bar = page.getByTestId("food-log-bar");
  await expect(bar).toBeVisible();

  const count = page.getByTestId("count-nuts_seeds");
  const before = Number((await count.textContent())?.trim() || "0");

  // One tap → optimistic increment.
  await page.getByTestId("log-nuts_seeds").click();
  await expect(count).toHaveText(String(before + 1));

  // The weekly rollup (server-rendered) reflects the serving after refresh.
  await expect(page.getByTestId("food-weekly-rollup")).toBeVisible();
  await expect(page.getByTestId("rollup-nuts_seeds")).toBeVisible();

  // Undo → decrement back (leave the fixture as found).
  await page.getByTestId("undo-nuts_seeds").click();
  await expect(count).toHaveText(String(before));
});

test("the labs food-suggestions card is collapsed by default and expands on click (#591)", async ({
  page,
}) => {
  await page.goto("/nutrition");

  // The container (native <details>) is present, keeping its testid, with a compact
  // one-line summary showing the count. The seeded profile has flagged-low omega-3 +
  // folate readings (e2e/seed-events.ts), so a suggestion exists.
  const card = page.getByTestId("nutrition-suggestions");
  await expect(card).toBeVisible();
  const summary = page.getByTestId("nutrition-suggestions-summary");
  await expect(summary).toContainText("Food suggestions from your labs");

  // Collapsed by default: a suggestion inside is not shown until the card is opened.
  const suggestion = page.getByTestId("food-suggestion-omega-3");
  await expect(suggestion).toBeHidden();

  // Expand → the suggestion becomes visible.
  await summary.click();
  await expect(suggestion).toBeVisible();
});

test("the Trends → Nutrition tab renders the food-servings rollup (#579)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const section = page.getByTestId("nutrition-trends");
  await expect(section).toBeVisible();
  // The seed logs leafy greens most days, so its rollup row is present over the range.
  await expect(page.getByTestId("nutrition-trends-rollup")).toBeVisible();
  await expect(section.getByTestId("rollup-leafy_greens")).toBeVisible();
});
