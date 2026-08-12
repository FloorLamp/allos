import { test, expect } from "./fixtures";
import {
  expectNoClippedContent,
  followLink,
  hydratedClick,
  settledBoxes,
} from "./helpers";
import { frozenNow } from "./worker-env";

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
      // First interaction after the goto, on a client toggle: a bare click here
      // can be swallowed pre-hydration, and the ONLY thing waiting for its
      // effect below is `boundingBox()`, which does not retry — so a lost click
      // burnt the whole 30 s test timeout instead of failing at five (shard 7 of
      // #2559's run).
      await hydratedClick(page, rowButton);
    }

    const [calendarBox, rowBox] = await settledBoxes([
      section.getByTestId("day-history-calendar-panel"),
      section.getByTestId("day-history-rowpanel"),
    ]);
    expect(rowBox.y).toBeGreaterThanOrEqual(calendarBox.y + calendarBox.height);
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

// ---- The grain follows the window (#2413) ----------------------------------
//
// The histories used to CLAMP a year-scale request back to their 13-week day
// cap, so 1Y and All-time silently rendered the most recent quarter and the
// range pill did nothing above it. Above the cap the SAME history now renders
// at week grain — no toggle, because the range picker already asked.
const YEAR_AGO = new Date(frozenNow().getTime() - 364 * 24 * 3600 * 1000)
  .toISOString()
  .slice(0, 10);

test("a year-scale range re-grains the intake history to weeks (#2413)", async ({
  page,
}) => {
  // The 90D default is untouched: day cells, no strip.
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  await expect(history.getByTestId("day-history-calendar")).toBeVisible();
  await expect(history.getByTestId("day-history-day")).not.toHaveCount(0);
  await expect(history.getByTestId("day-history-strip")).toHaveCount(0);

  // The range pill now visibly re-windows it. Direct navigation, not a
  // relative advance — the range lives in the URL.
  await page.goto(`/trends?tab=nutrition&from=${YEAR_AGO}`);
  await expect(page).toHaveURL(/from=/);

  // The 7-row calendar is replaced by the single-row week strip.
  const strip = history.getByTestId("day-history-strip");
  await expect(strip).toBeVisible();
  await expect(history.getByTestId("day-history-calendar")).toHaveCount(0);
  await expect(history.getByTestId("day-history-day")).toHaveCount(0);

  // Week cells, capped at the trailing-12-months convention.
  const weeks = history.getByTestId("day-history-week");
  await expect(weeks).not.toHaveCount(0);
  expect(await weeks.count()).toBeLessThanOrEqual(53);

  // The heading counts WEEKS, not days.
  await expect(history.getByTestId("day-history-calendar-panel")).toHaveCount(
    0
  );
  await expect(history.getByTestId("day-history-strip-panel")).toContainText(
    "Weeks logged"
  );

  // The dose history re-grains with it — one decision, both sections.
  await expect(
    page.getByTestId("dose-history").getByTestId("day-history-strip")
  ).toBeVisible();
});

test("selecting a week opens the WEEK panel, and the live week says how far it got (#2413)", async ({
  page,
}) => {
  await page.goto(`/trends?tab=nutrition&from=${YEAR_AGO}`);
  const history = page.getByTestId("intake-history");
  const weeks = history.getByTestId("day-history-week");
  await expect(weeks.first()).toBeVisible(); // first-ok: read-only presence before selecting

  await hydratedClick(page, weeks.last());
  const panel = history.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  // A week cell names its week, never its Sunday alone.
  await expect(panel.getByTestId("day-history-panel-title")).toContainText(
    "Week of"
  );

  // "Log for this day" seeds a DATE into a writer; a week is not a date, so
  // the offer is withheld rather than filing the entry on a day nobody picked.
  await expect(panel.getByTestId("day-history-add-link")).toHaveCount(0);

  // The Timeline link spans the week rather than pointing at one day.
  const timeline = panel.getByRole("link", { name: "Timeline →" });
  const href = await timeline.getAttribute("href");
  const match = href!.match(/from=(\d{4}-\d{2}-\d{2})&to=(\d{4}-\d{2}-\d{2})/);
  expect(match).not.toBeNull();
  expect(match![2] > match![1]).toBe(true);

  // The trailing week is PARTIAL — kept (it is the live week) and declared, so
  // its smaller total never reads as a decline.
  await expect(weeks.last()).toHaveAttribute("data-partial", "true");
});

// #2582: in a heatmap the cell's fill level IS the data, so nothing translucent may
// sit on a cell. The shared DayHistory calendar used to overlay its month and weekday
// labels on the grid behind a `bg-white/70` + blur chip, which made a covered day read
// as a level LIGHTER than it has. The labels now live in reserved gutters, so the
// invariant is geometric and checkable: no axis label's box may intersect any cell's.
//
// Asserted here because the food calendar is the widest seeded day-grain window in the
// suite — the component is shared, so the four consumers (food, dose, workout,
// practice) inherit the same geometry from the same constants.
test("calendar axis labels sit outside the grid, never on a cell (#2582)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/trends?tab=nutrition");
  const history = page.getByTestId("intake-history");
  const calendar = history.getByTestId("day-history-calendar");
  await expect(calendar).toBeVisible();

  const weekdays = calendar.getByTestId("day-history-weekday-label");
  // ALL SEVEN rows are labelled. Only alternating rows were, which meant counting
  // rows to find Tue — an artifact of the labels colliding with the cells.
  await expect(weekdays).toHaveCount(7);
  const months = calendar.getByTestId("day-history-month-label");
  await expect(months).not.toHaveCount(0);

  // Calendar cells resize themselves after mount (they grow toward 34px when the
  // window is short), so wait for a layout that holds still before measuring.
  await settledBoxes([
    calendar.getByTestId("day-history-weekday-label").first(), // first-ok: any one label proves the whole grid has settled
    calendar.getByTestId("day-history-day").first(), // first-ok: same, on the cell side
  ]);

  const overlaps = await calendar.evaluate((root) => {
    // One layout pass, so every rect below belongs to the same layout.
    const rect = (el: Element) => el.getBoundingClientRect();
    const labels = [
      ...root.querySelectorAll<HTMLElement>(
        '[data-testid="day-history-weekday-label"],[data-testid="day-history-month-label"]'
      ),
    ];
    const cells = [...root.querySelectorAll<HTMLElement>("button[data-date]")];
    // Sub-pixel tolerance: a fractional cell size can put a label's edge and a
    // cell's edge a hair apart, which is touching, not covering.
    const EPS = 0.5;
    const hits: string[] = [];
    for (const label of labels) {
      const l = rect(label);
      for (const cell of cells) {
        const c = rect(cell);
        const dx = Math.min(l.right, c.right) - Math.max(l.left, c.left);
        const dy = Math.min(l.bottom, c.bottom) - Math.max(l.top, c.top);
        if (dx > EPS && dy > EPS) {
          hits.push(
            `"${label.textContent}" covers ${cell.dataset.date} by ` +
              `${dx.toFixed(1)}x${dy.toFixed(1)}px`
          );
        }
      }
    }
    return hits;
  });
  expect(overlaps, overlaps.join("\n")).toEqual([]);

  // The matrix's frozen first column is a different case: it necessarily sits over
  // cells at any scroll offset past zero, and those cells stay reachable by
  // scrolling. What it may NOT do is leave them dimly visible through it — a
  // washed-out cell states a level it does not have. So its backdrop is opaque.
  const label = history.locator("[data-matrix-label]").first(); // first-ok: every matrix row label shares one backdrop constant
  const backdrop = await label.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      backgroundColor: cs.backgroundColor,
      backdropFilter: cs.backdropFilter,
    };
  });
  // No fractional alpha, and no blur reaching the cells behind it.
  expect(backdrop.backgroundColor).not.toMatch(/,\s*0(\.\d+)?\s*\)/);
  expect(backdrop.backdropFilter).toBe("none");
});
