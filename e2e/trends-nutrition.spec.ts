import { test, expect } from "@playwright/test";
import { followLink } from "./helpers";

// Trends → Nutrition is the OVER-TIME nutrition view (issue #1166): the macros+fiber
// daily chart (re-homed off Trends → Body and gaining fiber), a food-goal adherence
// trend, and an intake-history pattern grid whose days link INTO the Timeline. The
// duplicate FoodWeeklyRollup left the tab (its home is /nutrition). Driven read-only
// against the shared seeded admin profile: scripts/seed.ts ships ~8 weeks of food
// servings, a fatty-fish weekly habit, confirmed supplement doses, and (new) tracked
// macros/fiber metric samples dated outside the current week.

test("Trends → Nutrition shows the macros+fiber chart, the adherence trend, and the intake grid (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  await expect(page.getByRole("tab", { name: "Nutrition" })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  // Part 1 — macros + fiber over time. The seeded tracked series renders the stacked
  // chart (not the empty-state hint); the four series legend names fiber.
  const macros = page.getByTestId("nutrition-macros-chart");
  await expect(macros).toBeVisible();
  await expect(macros).toContainText("Macros & fiber");
  await expect(macros.getByText("Fiber", { exact: true })).toBeVisible();

  // Part 2 — food-goal adherence trend over the fatty-fish habit's history.
  const adherence = page.getByTestId("food-adherence-trend");
  await expect(adherence).toBeVisible();
  await expect(adherence.getByTestId("adherence-week").first()).toBeVisible(); // first-ok: read-only presence on a spec-scoped card
  await expect(adherence.getByTestId("adherence-week")).not.toHaveCount(0);

  // Part 3 — intake-history pattern grid, nutrition-scoped, with day cells present.
  const matrix = page.getByTestId("intake-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix.getByTestId("intake-matrix-day")).not.toHaveCount(0);

  // The duplicate servings rollup is gone from the Trends tab (it lives on /nutrition).
  await expect(page.getByTestId("food-weekly-rollup")).toHaveCount(0);
  await expect(page.getByTestId("nutrition-trends-rollup")).toHaveCount(0);
});

test("an intake-grid day links into the Timeline's day view (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const matrix = page.getByTestId("intake-matrix");
  await expect(matrix).toBeVisible();

  // Each day cell is a link to the Timeline filtered to that single day.
  const day = matrix.getByTestId("intake-matrix-day").first(); // first-ok: read-only, any populated day proves the link shape
  await expect(day).toHaveAttribute(
    "href",
    /\/timeline\?from=.*&to=.*#timeline-day-/
  );
  await followLink(page, day, /\/timeline\?from=/);
  await expect(page).toHaveURL(/\/timeline\?from=/);
});

test("the macros chart is GONE from Trends → Body (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");
  await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // Body is body-metrics/vitals now; macros moved to Nutrition. Neither the classic
  // Macros chart heading nor a macros anchor/jump-chip remains here.
  await expect(page.getByText("Macros (protein / carbs / fat)")).toHaveCount(0);
  await expect(page.locator("#macros")).toHaveCount(0);
});
