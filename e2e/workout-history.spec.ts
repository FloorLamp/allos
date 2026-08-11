import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import {
  DEFAULT_FORMAT_PREFS,
  formatLongDate,
  formatMonthDay,
} from "@/lib/format-date";

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
  // The aggregate lives under the calendar heading, not in a permanent matrix
  // footer. The exact scale shares the matrix header's top-right controls.
  await expect(section.getByTestId("day-history-detail")).toHaveCount(0);
  const matrixHeader = section.getByTestId("day-history-matrix-header");
  const matrixScale = matrixHeader.getByTestId("day-history-scale");
  await expect(matrixScale).toBeVisible();
  const [matrixHeaderBefore, matrixScaleBefore] = await Promise.all([
    matrixHeader.boundingBox(),
    matrixScale.boundingBox(),
  ]);
  // Today is text, not extra chart chrome: its calendar square names the day,
  // while matrix cells keep only their ordinary colored tile (no rail/fill).
  const calendarToday = calendar.locator('button[aria-current="date"]');
  const todayDate = await calendarToday.getAttribute("data-date");
  await expect(calendarToday.getByTestId("day-history-cell-date")).toHaveText(
    String(Number(todayDate!.slice(8, 10)))
  );
  const gapDay = calendar.locator("button[data-date]").first(); // first-ok: the first grid day owns both a right and lower gap; edge days intentionally do not
  const gapSummary = await gapDay.getAttribute("aria-label");
  const [hitBox, tileBox] = await Promise.all([
    gapDay.boundingBox(),
    gapDay.locator(":scope > span").boundingBox(),
  ]);
  expect(hitBox!.width).toBeGreaterThan(tileBox!.width);
  expect(hitBox!.height).toBeGreaterThan(tileBox!.height);
  await gapDay.hover({
    position: { x: tileBox!.width + 1, y: tileBox!.height + 1 },
  });
  await expect(section.getByTestId("day-history-detail")).toHaveText(
    gapSummary!
  );
  await expect(
    matrixHeader.getByTestId("day-history-visible-range")
  ).toBeVisible();
  const [matrixHeaderAfter, matrixScaleAfter] = await Promise.all([
    matrixHeader.boundingBox(),
    matrixScale.boundingBox(),
  ]);
  expect(matrixHeaderAfter!.height).toBe(matrixHeaderBefore!.height);
  expect(matrixScaleAfter!.x).toBe(matrixScaleBefore!.x);

  // The MATRIX half — "what was it", the question a day total cannot answer.
  // At least one named activity row, which is what #2415 added over the heatmap.
  await expect(section.getByTestId("day-history-row")).not.toHaveCount(0);
  const rowHeader = section.locator('[role="rowheader"]').first(); // first-ok: every sticky matrix label shares the same fade/padding treatment
  await expect(rowHeader).toHaveCSS("background-image", /linear-gradient/);
  await expect(rowHeader).toHaveCSS("padding-left", "12px");
  await expect(rowHeader).toHaveCSS("padding-right", "12px");
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
  await expect(
    calendar.locator('button[data-row-match="false"] > span.opacity-20').first() // first-ok: any non-matching calendar day proves the row projection strongly recedes its peers
  ).toBeVisible();
  await expect(rowHeader.locator("xpath=..")).toHaveClass(/bg-slate-500\/10/);
  const hoveredRowCell = rowHeader
    .locator("xpath=..")
    .locator('[role="gridcell"]')
    .first(); // first-ok: every cell in the hovered row shares its undimmed row treatment
  await expect(hoveredRowCell.locator(":scope > span")).not.toHaveClass(
    /opacity-40/
  );
  const peerRowCell = section
    .getByTestId("day-history-row")
    .nth(1)
    .locator('[role="gridcell"]')
    .first(); // first-ok: any cell in a non-hovered peer row proves peer dimming
  await expect(peerRowCell.locator(":scope > span")).toHaveClass(/opacity-40/);

  // The sticky label is also the row's selection control. It advertises that
  // affordance, then turns the matrix pattern into an exact occurrence ledger.
  const rowLabelButton = rowHeader.getByRole("button", {
    name: /View occurrences for/,
  });
  await expect(rowLabelButton).toHaveCSS("cursor", "pointer");
  await expect(rowLabelButton).toHaveCSS("font-weight", "600");
  await expect(rowLabelButton).toHaveCSS("text-decoration-line", "none");
  await rowLabelButton.click();
  await expect(rowLabelButton).toHaveAttribute("aria-pressed", "true");
  await expect(
    section.getByTestId("day-history-calendar-row-context")
  ).toHaveText(`${rowLabel} days`);
  await matrixHeader.hover();
  await expect(calendar.locator('button[data-row-match="true"]')).toHaveCount(
    activeDates.length
  );
  await expect(rowLabelButton).toHaveCSS("font-weight", "600");
  await expect(rowHeader.locator("xpath=..")).toHaveClass(/bg-slate-500\/10/);
  const rowPanel = section.getByTestId("day-history-rowpanel");
  await expect(rowPanel).toBeVisible();
  await expect(rowPanel).toHaveCSS("border-top-width", "0px");
  const calendarPanel = section.getByTestId("day-history-calendar-panel");
  const calendarHeading = calendarPanel.getByRole("heading", {
    name: "Active days",
  });
  await expect(
    calendarPanel.getByTestId("day-history-calendar-row-summary")
  ).toHaveCount(0);
  const rowHeading = rowPanel.getByRole("heading", { name: rowLabel! });
  await expect(calendarHeading).toHaveCSS("font-size", "14px");
  await expect(calendarHeading).toHaveCSS("font-weight", "600");
  await expect(rowHeading).toHaveCSS("font-size", "14px");
  await expect(rowHeading).toHaveCSS("font-weight", "600");
  const [calendarPanelBox, rowPanelBox] = await Promise.all([
    calendarPanel.boundingBox(),
    rowPanel.boundingBox(),
  ]);
  expect(Math.abs(calendarPanelBox!.width - rowPanelBox!.width)).toBeLessThan(
    1
  );
  expect(rowPanelBox!.x).toBeGreaterThan(
    calendarPanelBox!.x + calendarPanelBox!.width
  );
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
  const currentDayCell = section
    .getByTestId("day-history-matrix")
    .locator('[role="gridcell"][aria-current="date"]')
    .first(); // first-ok: every activity row's current-day cell has the same no-extra-chrome contract
  await expect(currentDayCell.locator(":scope > span")).toHaveCount(1);
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

  // Hover identifies the tiny calendar square in place and pins the same date
  // directly over its matrix column. The weekly header labels near it yield so
  // the exact-date marker never becomes a pile of overlapping text.
  await day.hover();
  await expect(day.getByTestId("day-history-cell-date")).toHaveText(
    String(Number(date!.slice(8, 10)))
  );
  const hoverMarker = section.locator(
    `[data-testid="day-history-date-marker"][data-date="${date}"]`
  );
  await expect(hoverMarker).toHaveText(
    formatMonthDay(date!, DEFAULT_FORMAT_PREFS)
  );

  // A cell SELECTS rather than navigating (#2415): the URL must not move.
  await day.click();
  await expect(day).toHaveAttribute("aria-pressed", "true");
  await expect(day.getByTestId("day-history-cell-date")).toHaveText(
    String(Number(date!.slice(8, 10)))
  );
  await expect(
    section.locator(
      `[data-testid="day-history-date-marker"][data-date="${date}"]`
    )
  ).toHaveText(formatMonthDay(date!, DEFAULT_FORMAT_PREFS));
  const matchingMatrixCell = section
    .getByTestId("day-history-matrix")
    .locator(`[role="gridcell"][data-date="${date}"]`)
    .first(); // first-ok: every activity row shares this date column
  await expect
    .poll(async () => {
      const [markerBox, cellBox] = await Promise.all([
        hoverMarker.boundingBox(),
        matchingMatrixCell.boundingBox(),
      ]);
      return Math.abs(
        markerBox!.x + markerBox!.width / 2 - (cellBox!.x + cellBox!.width / 2)
      );
    })
    .toBeLessThan(1.5);
  await expect
    .poll(() =>
      matchingMatrixCell.evaluate((cell) => {
        const scroller = cell.closest<HTMLElement>(
          '[data-testid="day-history-matrix"]'
        )!;
        const label = scroller.querySelector<HTMLElement>(
          "[data-matrix-label]"
        )!;
        const cellRect = cell.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        return (
          cellRect.left >=
            scrollerRect.left + label.getBoundingClientRect().width &&
          cellRect.right <= scrollerRect.right
        );
      })
    )
    .toBe(true);
  await expect(matchingMatrixCell.locator(":scope > span")).not.toHaveClass(
    /opacity-40/
  );
  const unselectedDateCell = section
    .getByTestId("day-history-matrix")
    .locator(
      `[role="gridcell"][data-matrix-row="0"]:not([data-date="${date}"])`
    )
    .first(); // first-ok: any other date in the row proves selected-column dimming
  await expect(unselectedDateCell.locator(":scope > span")).toHaveClass(
    /opacity-40/
  );
  const panel = section.getByTestId("day-history-daypanel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveCSS("border-top-width", "0px");
  await expect(panel.getByRole("heading")).toHaveCSS("font-size", "14px");
  await expect(panel.getByRole("heading")).toHaveCSS("font-weight", "600");
  const [calendarPanelBox, dayPanelBox] = await Promise.all([
    section.getByTestId("day-history-calendar-panel").boundingBox(),
    panel.boundingBox(),
  ]);
  expect(Math.abs(calendarPanelBox!.width - dayPanelBox!.width)).toBeLessThan(
    1
  );
  expect(dayPanelBox!.x).toBeGreaterThan(
    calendarPanelBox!.x + calendarPanelBox!.width
  );
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
  const entrySummary = await entry.getAttribute("aria-label");

  // The colored tile is 18×26 inside a 20×29 hit target. Hover its bottom-right
  // whitespace: the group+day summary must remain active while crossing both
  // the horizontal and vertical visual gaps.
  const [entryBox, entryTileBox] = await Promise.all([
    entry.boundingBox(),
    entry.locator(":scope > span").boundingBox(),
  ]);
  expect(
    Math.abs(
      entryBox!.y +
        entryBox!.height / 2 -
        (entryTileBox!.y + entryTileBox!.height / 2)
    )
  ).toBeLessThan(0.6);
  await entry.hover({ position: { x: 19, y: 28 } });
  await expect(section.getByTestId("day-history-detail")).toHaveText(
    entrySummary!
  );

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
