import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink } from "./helpers";

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

test("a no-param load opens on 90D, with All time one tap away", async ({
  page,
}) => {
  await page.goto("/trends");

  // The lit pill is the answer to "what window am I looking at?", so the default
  // has to LIGHT one — a window matching no pill would read as custom.
  await expect(rangePill(page, "90D")).toHaveAttribute("aria-current", "true");
  await expect(rangePill(page, "All time")).not.toHaveAttribute("aria-current");

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
