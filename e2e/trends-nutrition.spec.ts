import { test, expect } from "./fixtures";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";

// Trends → Nutrition is the OVER-TIME nutrition view (issue #1166): the macros+fiber
// daily chart (re-homed off Trends → Overview → body census and gaining fiber), a food-goal adherence
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

  // The intake history LEADS the tab: the day-history calendar (coverage) and
  // the group×day matrix (composition), with populated day cells and group rows.
  const history = page.getByTestId("intake-history");
  await expect(history).toBeVisible();
  await expect(history.getByTestId("day-history-calendar")).toBeVisible();
  await expect(history.getByTestId("day-history-day")).not.toHaveCount(0);
  await expect(history.getByTestId("day-history-row")).not.toHaveCount(0);

  // Confirmed doses are their OWN history section (never a dot overlay on the
  // food calendar); the seeded confirmed doses give it rows.
  const doses = page.getByTestId("dose-history");
  await expect(doses).toBeVisible();
  await expect(doses.getByTestId("day-history-row")).not.toHaveCount(0);

  // The duplicate servings rollup is gone from the Trends tab (it lives on /nutrition).
  await expect(page.getByTestId("food-weekly-rollup")).toHaveCount(0);
  await expect(page.getByTestId("nutrition-trends-rollup")).toHaveCount(0);
});

test("food and dose histories stay contained and stack details on a phone", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trends?tab=nutrition");

  const cases = [
    {
      section: page.getByTestId("intake-history"),
      helper:
        /Calendar: days you logged food\. Matrix: each day by food group\./,
    },
    {
      section: page.getByTestId("dose-history"),
      helper: /Calendar: days you confirmed doses\. Matrix: each day by item\./,
    },
  ];

  for (const { section, helper } of cases) {
    await expect(section).toContainText(helper);
    const rowButton = section
      .getByRole("button", { name: /View occurrences for/ })
      .first(); // first-ok: every domain row shares the same responsive detail-panel contract
    if ((await rowButton.getAttribute("aria-pressed")) !== "true") {
      await rowButton.click();
    }

    const [calendarBox, rowBox] = await Promise.all([
      section.getByTestId("day-history-calendar-panel").boundingBox(),
      section.getByTestId("day-history-rowpanel").boundingBox(),
    ]);
    expect(rowBox).not.toBeNull();
    expect(rowBox!.y).toBeGreaterThanOrEqual(
      calendarBox!.y + calendarBox!.height
    );
  }

  await expectNoClippedContent(page);
});

test("a day tap opens the day panel; the Timeline stays one link away (#1166)", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  await expect(history).toBeVisible();

  // Tapping a populated day SELECTS it — no navigation — and the panel lists
  // what that day held.
  const day = history.getByTestId("day-history-day").first(); // first-ok: read-only, any populated day proves the interaction
  await hydratedClick(page, day);
  await expect(page).toHaveURL(/\/trends\?tab=nutrition/);
  const panel = history.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("day-history-day-item")).not.toHaveCount(0);

  // The Timeline link inside the panel carries the single-day shape.
  const link = panel.getByRole("link", { name: /Timeline/ });
  await expect(link).toHaveAttribute(
    "href",
    /\/timeline\?from=.*&to=.*#timeline-day-/
  );
  await followLink(page, link, /\/timeline\?from=/);
  await expect(page).toHaveURL(/\/timeline\?from=/);
});

// #2417: the dose calendar's "what did I take that day" is the cross-item dose
// ledger filtered to that day, so the dose section's day panel carries a link the
// food section's does not — declared per DOMAIN, not per caller.
test("a dose day panel links into the dose ledger for that day", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const doses = page.getByTestId("dose-history");
  await expect(doses).toBeVisible();

  // The section's own header link reaches the ledger across both kinds.
  await expect(doses.getByTestId("dose-history-ledger-link")).toHaveAttribute(
    "href",
    "/nutrition/dose-history?kind=all"
  );

  const day = doses.getByTestId("day-history-day").first(); // first-ok: read-only, any populated dose day proves the interaction
  await hydratedClick(page, day);
  const panel = doses.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  const link = panel.getByTestId("day-history-day-link");
  await expect(link).toHaveAttribute(
    "href",
    /\/nutrition\/dose-history\?from=.*&to=.*&kind=all/
  );
  await followLink(page, link, /\/nutrition\/dose-history\?from=/);
  const ledger = page.getByTestId("dose-ledger");
  await expect(ledger).toBeVisible();
  // The food section's panel has no such link — the declaration is per domain.
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  await hydratedClick(page, history.getByTestId("day-history-day").first()); // first-ok: read-only, any populated food day proves the absence
  await expect(
    history
      .getByTestId("day-history-daypanel")
      .getByTestId("day-history-day-link")
  ).toHaveCount(0);
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

  // The selected count stays visible and All is the explicit recovery action.
  await expect(
    history.getByText(/Viewing \d+ of \d+ food groups/)
  ).toBeVisible();
  await history.getByRole("button", { name: "All", exact: true }).click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(
    history.locator(`[data-testid="day-history-row"][data-group="${group}"]`)
  ).toBeVisible();

  await history.getByRole("button", { name: "None", exact: true }).click();
  await expect(history.getByTestId("day-history-row")).toHaveCount(0);
  await history.getByRole("button", { name: "All", exact: true }).click();
  await expect(history.getByTestId("day-history-row")).not.toHaveCount(0);
});

test("a long group filter starts compact and can reveal the full vocabulary", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  const filterToggle = history.getByTestId("day-history-filter-toggle");
  await expect(filterToggle).toHaveAttribute("aria-expanded", "false");
  await expect(filterToggle).toHaveText(/^\+\d+ more$/);
  expect(await history.getByTestId("day-history-chip").count()).toBe(5);

  const filterButtons = await history
    .getByRole("group", { name: "Filter food groups" })
    .getByRole("button")
    .allTextContents();
  expect(filterButtons.findIndex((text) => /^\+\d+ more$/.test(text))).toBe(
    filterButtons.indexOf("All") - 1
  );

  await filterToggle.click();
  await expect(filterToggle).toHaveAttribute("aria-expanded", "true");
  await expect(filterToggle).toHaveText("Show less");
  expect(await history.getByTestId("day-history-chip").count()).toBeGreaterThan(
    5
  );
});

test("filtering to one row selects it temporarily and keeps one keyboard entry point", async ({
  page,
}) => {
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  const grid = history.getByRole("grid", { name: /By food group/ });
  expect(Number(await grid.getAttribute("aria-rowcount"))).toBeGreaterThan(1);

  // Move the roving stop onto a row that will disappear, clear the matrix,
  // then restore only one group. The new one-row grid must still be tabbable.
  const lastCell = grid.locator('[role="gridcell"]').last();
  await lastCell.focus();
  await expect(lastCell).toBeFocused();
  await history.getByRole("button", { name: "None", exact: true }).click();
  await expect(grid).toHaveCount(0);
  const onlyChip = history.getByTestId("day-history-chip").first(); // first-ok: any one remaining group produces the one-row shrink case
  const onlyGroup = await onlyChip.getAttribute("data-group");
  const onlyLabel = await onlyChip.getAttribute("aria-label");
  expect(onlyGroup).toBeTruthy();
  expect(onlyLabel).toBeTruthy();
  await onlyChip.click();

  const restored = history.getByRole("grid", { name: /By food group/ });
  await expect(restored.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(
    1
  );
  const onlyRow = history.locator(
    `[data-testid="day-history-row"][data-group="${onlyGroup}"]`
  );
  await expect(
    onlyRow.getByRole("button", { name: /View occurrences for/ })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    history.getByTestId("day-history-rowpanel").getByRole("heading")
  ).toHaveText(onlyLabel!);

  // The sole-row selection belongs to the filter state, not the user. Adding
  // a second row removes it; filtering from two rows back to one restores it.
  const secondChip = history.getByTestId("day-history-chip").nth(1);
  await secondChip.click();
  await expect(history.getByTestId("day-history-rowpanel")).toHaveCount(0);
  await expect(
    onlyRow.getByRole("button", { name: /View occurrences for/ })
  ).toHaveAttribute("aria-pressed", "false");

  await secondChip.click();
  await expect(
    onlyRow.getByRole("button", { name: /View occurrences for/ })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    history.getByTestId("day-history-rowpanel").getByRole("heading")
  ).toHaveText(onlyLabel!);
});
