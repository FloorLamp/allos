import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { settledClick, followLink } from "./helpers";
import type { Locator } from "@playwright/test";

// #1485 G — Trends opens on 90D, and a sparse series shows its latest reading.
//
// Two behaviours, one cause. All-time as the no-param default made every slope
// read as a lifetime average; 90D fixes that but immediately creates the second
// problem, because an annual lab has NOTHING in a 90-day window. So the default
// only holds up if a series with no in-window points still answers "what is my
// last value?" — hence both halves live in one spec.
//
// The contract that must never bend: a URL that SAYS something is never
// reinterpreted. Only the URL that says nothing gained a meaning.
//
// Fixture (#868 hygiene): CREATE-AND-CLEAN on the shared seed. The sparse test
// stars an analyte the seed leaves unsaved (seeded saves: LDL Cholesterol, ApoB,
// hs-CRP, Lipoprotein(a) + the weight metric) and un-stars it through the tile's
// own control, restoring seed state — repeat-safe, perturbing no neighbour. No
// exact count of a shared-seed row is asserted.

// A seeded biomarker the seed deliberately stops drawing ("not retested recently"
// in scripts/seed.ts): four readings, the newest ~450 days old. So it is empty in a
// 90-day window but has real history — exactly the shape the fallback exists for.
// The seed does not star it, so this spec owns its save.
const SPARSE_ANALYTE = "Free T4";
const SPARSE_LATEST = "1.3 ng/dL"; // its newest reading, in its own unit

// A range pill, located EXACTLY. Playwright matches an accessible name by
// case-insensitive SUBSTRING by default, and the movers digest sits on this same
// page rendering its chips as LINKS labelled "… over 90d" (lib/trends-digest) —
// so a bare { name: "90D" } resolves to the pill AND to any chip whose series
// spans exactly the window, a strict-mode violation that fires only on the run
// dates where such a mover exists. Bounding the default window (#1485 G) is what
// brought those "7d"/"30d"/"90d" fragments into reach: under all time the span was
// the whole history and could never collide.
const rangePill = (page: Page, label: string) =>
  page.getByRole("link", { name: label, exact: true });

// A tile's unstar control (#1485 B): open its corner ⋯ menu, then take the item out
// of the portaled panel. Returns the locator for settledClick to drive.
async function unstarItem(page: Page, tile: Locator): Promise<Locator> {
  await tile.getByTestId("overflow-menu-trigger").click();
  const menu = page.getByTestId("trend-tile-menu");
  await expect(menu).toBeVisible();
  return menu.getByTestId("star-toggle");
}

// The seeded genomics marker (e2e/seed-events.ts): STARRED, dated 2023, and
// qualitative — 'e3/e4' has no numeric value at all, so nothing can be plotted for
// it under any window. Read-only here; the spec stars nothing to use it.
const GENOTYPE_ANALYTE = "E2E APOE Genotype";

test("a no-param load opens on 90D, with All time one tap away", async ({
  page,
}) => {
  await page.goto("/trends");

  // The lit pill is the answer to "what window am I looking at?", so the default
  // has to LIGHT one — a window matching no pill would read as custom.
  await expect(rangePill(page, "90D")).toHaveAttribute("aria-current", "page");
  await expect(rangePill(page, "All time")).not.toHaveAttribute(
    "aria-current",
    "page"
  );

  // All time still reachable in one tap — and it must SURVIVE, which is the whole
  // reason it needs an explicit sentinel: it used to clear the params, and a
  // cleared URL is now the default.
  await followLink(page, rangePill(page, "All time"), /range=all/);
  await expect(rangePill(page, "All time")).toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(rangePill(page, "90D")).not.toHaveAttribute(
    "aria-current",
    "page"
  );

  // ...including across a Body layout switch, which rebuilds every hub link. A
  // sentinel dropped here would silently rewind the user to 90D. (#1644 retired the
  // tab strip; the tiles/all toggle is now the hub link that carries the window.)
  await followLink(page, page.getByTestId("body-view-tiles"), /view=tiles/);
  await expect(page).toHaveURL(/range=all/);
  await expect(rangePill(page, "All time")).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("an explicit window in the URL always wins over the default", async ({
  page,
}) => {
  // A shared or bookmarked link. Its dates are honoured verbatim: no pill is lit,
  // the summary chip names the window, and nothing was rewritten to 90D.
  await page.goto("/trends?from=2026-01-01&to=2026-02-01");
  await expect(page.getByTestId("range-summary-chip")).toHaveText(
    "2026-01-01 → 2026-02-01"
  );
  await expect(rangePill(page, "90D")).not.toHaveAttribute(
    "aria-current",
    "page"
  );
  await expect(page).toHaveURL(/from=2026-01-01&to=2026-02-01/);
});

test("a sparse saved biomarker shows its latest reading and age, not 'No data'", async ({
  page,
}) => {
  await page.goto("/trends");
  const picker = page.getByTestId("save-trend-picker");
  await picker.getByRole("combobox").selectOption(`bio:${SPARSE_ANALYTE}`);
  await settledClick(page, picker.getByRole("button", { name: "Star" }));

  const tile = page
    .getByTestId("trend-mini-card")
    .filter({ hasText: SPARSE_ANALYTE });
  await expect(tile).toHaveCount(1);

  // The window is genuinely empty — but the tile answers with the last real
  // reading instead of throwing it away.
  const fallback = tile.getByTestId("trend-mini-outside-window");
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText(SPARSE_LATEST);
  await expect(tile).not.toContainText("No data in this range");
  const singleReading = tile.getByTestId("trend-mini-single-reading");
  await expect(singleReading).toBeVisible();
  await expect(singleReading).toHaveAttribute("data-reading-scope", "outside");
  await expect(singleReading).toContainText("Latest recorded ·");
  await expect(singleReading.locator("time")).toHaveAttribute(
    "datetime",
    /\d{4}-\d{2}-\d{2}/
  );

  // The age is the honesty marker: it is the only thing stopping a year-old value
  // from reading as current, so it is asserted as hard as the value is. (Pattern,
  // not a literal: the reading's date is fixed in the seed while "today" is the
  // run's own clock, so the exact bucket drifts with the calendar.)
  await expect(fallback).toContainText(/\d+(y|mo|w|d) ago/);
  await expect(fallback).toContainText("outside 90D range");

  // The same tile under an explicit all-time window draws the real series — the
  // fallback is a property of the WINDOW, not of the analyte.
  await page.goto("/trends?range=all");
  const allTimeTile = page
    .getByTestId("trend-mini-card")
    .filter({ hasText: SPARSE_ANALYTE });
  await expect(
    allTimeTile.getByTestId("trend-mini-outside-window")
  ).toHaveCount(0);
  await expect(allTimeTile.getByTestId("trend-mini-range")).toBeVisible();

  // Cleanup is the assertion: un-starring restores the seed state. The control
  // lives in the tile's corner ⋯ menu since #1485 B, and the menu panel is portaled
  // to <body>, so it is located on the page rather than inside the card.
  await settledClick(page, await unstarItem(page, allTimeTile));
  await expect(
    page.getByTestId("trend-mini-card").filter({ hasText: SPARSE_ANALYTE })
  ).toHaveCount(0);
});

test("a qualitative reading falls back too, though nothing can plot it", async ({
  page,
}) => {
  // A genotype has no numeric value, so a numeric-only fallback would silently
  // drop the one analyte whose value never changes and is never re-drawn — the
  // worst possible thing to hide behind "no data in this range".
  await page.goto("/trends");
  const tile = page
    .getByTestId("trend-mini-card")
    .filter({ hasText: GENOTYPE_ANALYTE });
  const fallback = tile.getByTestId("trend-mini-outside-window");
  await expect(fallback).toContainText("e3/e4");
  await expect(fallback).toContainText(/\d+(y|mo|w|d) ago/);
});

test("a never-measured saved biomarker keeps the plain empty tile", async ({
  page,
}) => {
  // The fallback needs history to fall back TO. The seed stars two analytes that
  // resolve to no readings at all, and those must keep the honest empty state —
  // a blanket replacement of it would invent a reading (and #1485 A's compaction
  // is scoped to exactly these).
  await page.goto("/trends");
  const saved = page.getByTestId("saved-tiles");
  const empty = saved
    .getByTestId("trend-mini-card")
    .filter({ hasText: "No data in this range" })
    .first(); // first-ok: any one never-measured tile proves the empty state survived; asserting a count of a shared-seed row is what #868 forbids
  await expect(empty).toBeVisible();
  await expect(empty.getByTestId("trend-mini-outside-window")).toHaveCount(0);
});
