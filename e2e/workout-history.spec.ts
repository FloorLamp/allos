import { test, expect } from "./fixtures";
import { followLink, hydratedClick } from "./helpers";
import { DEFAULT_FORMAT_PREFS, formatLongDate } from "@/lib/format-date";

// Issue #186's two questions, asked of the surface that now answers them.
//
// #186 shipped a workout-density heatmap; #2415 replaced it outright with the
// day-history substrate (calendar + matrix). The heatmap's spec died with the
// component, but its QUESTIONS did not, and deleting them with the markup would
// have quietly dropped desktop coverage of the tab's lead surface:
//
//   1. Does Trends → Fitness render a density view with active days?
//   2. Can a reader get from a workout day to that Training Log day?
//
// The second one's ANSWER changed, which is the point of re-asking it here.
// The heatmap made every active cell an anchor, so a tap navigated away. The
// day-history calendar makes a cell a BUTTON that SELECTS: the day panel opens
// in place and carries the Training Log link, so the deep link is still one tap
// away but no longer ambushes a reader who only wanted to see what a day held.
// A spec that just checked `href` on a cell would now pass on markup that had
// silently lost the route entirely.
//
// The mobile lens spec (trends-fitness-lens.mobile) covers the same section's
// WINDOWING; this is the desktop render + navigation pair. The seed lays down
// 16 weeks of PPL strength sessions (3/week) on relative dates, so the grid
// always has active cells. Read-only — no mutations to self-clean.

test("Trends → Fitness leads with the workout history and its active days (#186/#2415)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");

  const section = main.getByTestId("workout-history");
  await expect(section).toBeVisible();

  // The CALENDAR half — "how consistently did I train".
  const calendar = section.getByTestId("day-history-calendar");
  await expect(calendar).toBeVisible();
  expect(await calendar.getByTestId("day-history-day").count()).toBeGreaterThan(
    0
  );
  const matrixHeader = section.getByTestId("day-history-matrix-header");
  const matrixScale = matrixHeader.getByTestId("day-history-scale");
  await expect(matrixScale).toBeVisible();

  const calendarToday = calendar.locator('button[aria-current="date"]');
  const todayDate = await calendarToday.getAttribute("data-date");
  await expect(calendarToday.getByTestId("day-history-cell-date")).toHaveText(
    String(Number(todayDate!.slice(8, 10)))
  );
  await expect(
    matrixHeader.getByTestId("day-history-visible-range")
  ).toBeVisible();

  // The MATRIX half — "what was it", the question a day total cannot answer.
  // At least one named activity row, which is what #2415 added over the heatmap.
  await expect(section.getByTestId("day-history-row")).not.toHaveCount(0);
  const rowHeader = section.locator('[role="rowheader"]').first(); // first-ok: any activity row proves the shared row interaction
  const rowSummary = await rowHeader.getAttribute("aria-label");
  const rowLabel = await rowHeader.getAttribute("title");
  const rowCells = rowHeader.locator("xpath=..").locator('[role="gridcell"]');
  const activeDates = await rowCells.evaluateAll((cells) =>
    cells
      .filter(
        (cell) => !cell.getAttribute("aria-label")?.includes("— 0 sessions")
      )
      .map((cell) => cell.getAttribute("data-date")!)
  );
  expect(activeDates.length).toBeGreaterThan(0);
  await rowHeader.hover();
  await expect(section.getByTestId("day-history-detail")).toHaveText(
    rowSummary!
  );
  await expect(
    section.getByTestId("day-history-calendar-row-context")
  ).toHaveText(`${rowLabel} days`);
  await expect(
    section.getByTestId("day-history-calendar-row-summary")
  ).toHaveText(rowSummary!.split(": ").slice(1).join(": "));
  await expect(calendar.locator('button[data-row-match="true"]')).toHaveCount(
    activeDates.length
  );
  // Selecting a row turns the matrix pattern into an occurrence ledger.
  const rowLabelButton = rowHeader.getByRole("button", {
    name: /View occurrences for/,
  });
  await rowLabelButton.click();
  await expect(rowLabelButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    section.getByTestId("day-history-calendar-row-context")
  ).toHaveText(`${rowLabel} days`);
  const rowPanel = section.getByTestId("day-history-rowpanel");
  await expect(rowPanel).toBeVisible();
  const rowHeading = rowPanel.getByRole("heading", { name: rowLabel! });
  await expect(rowHeading).toBeVisible();
  await expect(rowPanel.getByTestId("day-history-row-occurrence")).toHaveCount(
    activeDates.length
  );
  const newestOccurrenceTime = rowPanel.locator("time").first(); // first-ok: the ledger contract puts its newest occurrence first
  await expect(newestOccurrenceTime).toHaveAttribute(
    "datetime",
    activeDates.at(-1)!
  );
  const newestOccurrence = rowPanel
    .getByTestId("day-history-row-occurrence")
    .first(); // first-ok: every occurrence carries the same quantity grammar
  await expect(newestOccurrence).toContainText(/\d+ sessions?/);
  await expect(newestOccurrence.getByRole("link")).toHaveAttribute(
    "href",
    `/training?tab=log#day-${activeDates.at(-1)}`
  );
});

test("selecting a workout day opens its panel, which links to that Training Log day (#186/#2415)", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const main = page.getByRole("main");
  const section = main.getByTestId("workout-history");
  await expect(section).toBeVisible();

  const cal = section.getByTestId("day-history-calendar");
  const day = cal.getByTestId("day-history-day").first(); // first-ok: asserts ANY active cell's date format and panel, not a specific day — order-agnostic
  const date = await day.getAttribute("data-date");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // A cell SELECTS rather than navigating (#2415): the URL must not move.
  await hydratedClick(page, day);
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(day.getByTestId("day-history-cell-date")).toHaveText(
    String(Number(date!.slice(8, 10)))
  );
  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  // The panel uses the login's human-readable date shape; the machine date
  // remains in the deep link below.
  await expect(panel).toContainText(
    formatLongDate(date!, DEFAULT_FORMAT_PREFS, { year: "always" })
  );
  await expect(page).toHaveURL(/tab=fitness/);

  // Workout review/editing belongs to the Training Log, anchored to this day.
  const link = panel.getByRole("link", { name: /Training log/ });
  await expect(link).toHaveAttribute("href", `/training?tab=log#day-${date}`);

  // followLink, not a raw click — a raw click intermittently lands in the
  // pre-hydration swallow window and never advances the URL, this spec's
  // retries=0 flake (#889/#868).
  await followLink(page, link, /\/training\?tab=log/);
  await expect(page.getByRole("main").locator(`#day-${date}`)).toBeVisible();
});

test("the matrix is one keyboard grid and selecting a cell opens the shared day panel", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const section = page.getByTestId("workout-history");
  const grid = section.getByRole("grid", { name: /By activity/ });
  const tabStops = grid.locator('[role="gridcell"][tabindex="0"]');
  await expect(tabStops).toHaveCount(1);
  const entry = tabStops.first(); // first-ok: the grid contract asserts exactly one
  const startingCol = Number(await entry.getAttribute("data-matrix-col"));
  await entry.focus();

  await entry.press("ArrowLeft");
  const focused = grid.locator('[role="gridcell"]:focus');
  await expect(focused).toBeVisible();
  expect(Number(await focused.getAttribute("data-matrix-col"))).toBe(
    startingCol - 1
  );

  await focused.press("Enter");
  await expect(focused).toHaveAttribute("aria-selected", "true");
  await expect(focused.locator(":scope > span")).toHaveCount(1);
  await expect(section.getByTestId("day-history-daypanel")).toBeVisible();
});

test("an empty calendar day is selectable and still reaches Timeline", async ({
  page,
}) => {
  await page.goto("/trends?tab=fitness");
  const section = page.getByTestId("workout-history");
  const emptyDay = section
    .getByTestId("day-history-calendar")
    .locator('button[data-active="false"]')
    .first(); // first-ok: any rest day proves empty cells are real controls
  await expect(emptyDay).toBeVisible();
  const date = await emptyDay.getAttribute("data-date");
  await emptyDay.click();

  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toContainText("Nothing logged this day");
  await expect(panel.getByRole("link", { name: /Timeline/ })).toHaveAttribute(
    "href",
    `/timeline?from=${date}&to=${date}#timeline-day-${date}`
  );
});
