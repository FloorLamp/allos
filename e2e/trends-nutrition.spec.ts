import { test, expect } from "./fixtures";
import { followLink } from "./helpers";

// Trends → Nutrition is the OVER-TIME nutrition view (issue #1166): the macros+fiber
// daily chart (re-homed off Trends → Body and gaining fiber), a food-goal adherence
// trend, and the intake history — the generalized day-history calendar + group×day
// matrix (lib/day-history.ts) whose days link INTO the Timeline. The duplicate
// FoodWeeklyRollup left the tab (its home is /nutrition). Driven read-only against
// the shared seeded admin profile: scripts/seed.ts ships ~8 weeks of food servings,
// a fatty-fish weekly habit, confirmed supplement doses, and tracked macros/fiber
// metric samples dated outside the current week.

test("Trends → Nutrition shows the macros+fiber chart, the adherence trend, and the intake history (#1166)", async ({
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

  // Part 3 — intake history: the day-history calendar (coverage) and the
  // group×day matrix (composition), with populated day cells and group rows.
  const history = page.getByTestId("intake-history");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("day-history-calendar")).toBeVisible();
  await expect(history.getByTestId("day-history-day")).not.toHaveCount(0);
  await expect(history.getByTestId("day-history-row")).not.toHaveCount(0);

  // The duplicate servings rollup is gone from the Trends tab (it lives on /nutrition).
  await expect(page.getByTestId("food-weekly-rollup")).toHaveCount(0);
  await expect(page.getByTestId("nutrition-trends-rollup")).toHaveCount(0);
});

test("an intake-history day links into the Timeline's day view (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  await expect(history).toBeVisible();

  // Each populated calendar day is a link to the Timeline filtered to that day.
  const day = history.getByTestId("day-history-day").first(); // first-ok: read-only, any populated day proves the link shape
  await expect(day).toHaveAttribute(
    "href",
    /\/timeline\?from=.*&to=.*#timeline-day-/
  );
  await followLink(page, day, /\/timeline\?from=/);
  await expect(page).toHaveURL(/\/timeline\?from=/);
});

test("a group filter chip removes that group's matrix row", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  await expect(history).toBeVisible();

  // The top-ranked row always has a chip of its own (folding only ever affects
  // the tail). Toggle it off: the chip unpresses and its row leaves the matrix.
  const firstRow = history.getByTestId("day-history-row").first(); // first-ok: rank order is deterministic for a given seed; any top row proves the filter
  const group = await firstRow.getAttribute("data-group");
  expect(group).toBeTruthy();
  const chip = history.locator(
    `[data-testid="day-history-chip"][data-group="${group}"]`
  );
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await expect(
    history.locator(`[data-testid="day-history-row"][data-group="${group}"]`)
  ).toHaveCount(0);
});

test("the macros chart is GONE from the body census (#1166)", async ({
  page,
}) => {
  // #1644: the Body tab merged into the Overview landing surface, so the census is
  // reached at its anchor on the default view.
  await page.goto("/trends#body");
  await expect(page.getByTestId("trends-section-body")).toBeVisible();
  // The census is body-metrics/vitals; macros moved to Nutrition. Neither the
  // classic Macros chart heading nor a macros anchor/jump-chip remains here.
  await expect(page.getByText("Macros (protein / carbs / fat)")).toHaveCount(0);
  await expect(page.locator("#macros")).toHaveCount(0);
});
