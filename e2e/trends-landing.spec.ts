import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

// The Trends LANDING SURFACE (#1644): the metric census moved into Overview.
//
// `/trends` is now one scroll — trending digest → cross-domain starred grid → the
// body census — while Fitness, Nutrition and Insights stay tabs. What this spec
// pins, and why each clause is a real regression class:
//
//   • COMPOSITION — digest first, grid second, census LAST, in DOM order. The
//     reading order IS the design (what changed → what you curated → the whole
//     domain); #2151 restores the two-anchor surface by moving practice charts to
//     /wellness.
//   • CURATION — the grid is still the only curated area: it renders the saved set
//     and the census below it renders everything. A census card leaking into the
//     grid (or a second picker appearing in the census) is the #1487 contract
//     breaking.
//   • STREAMING — the census arrives through Suspense BELOW the head, so the head
//     paints without waiting for ~30 body queries. Its heading and `#body` anchor
//     are in the first byte; its content follows.
//   • URL — `?tab=body` died with the tab, no shim (#1635): it falls through to the
//     default view, which is the surface that absorbed it. The surviving tabs'
//     URLs are untouched (e2e/trends-per-tab.spec.ts owns the strip itself).
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed — navigation and anchors
// only, nothing written, no shared-seed row exact-counted, so it is repeat-safe.

// The landing surface's direct children, in DOM order, named by testid — the one
// assertion that can see "digest at the head, census last" at once.
async function landingOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="trends-overview"] > *')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid") ?? el.id ?? "")
    );
}

test("the landing surface reads digest → starred grid → body census", async ({
  page,
}) => {
  await page.goto("/trends");

  const order = (await landingOrder(page)).filter(Boolean);
  // The two anchored parts, in reading order, with the census last.
  const parts = order.filter((id) => id.startsWith("trends-section-"));
  expect(
    parts,
    "the landing surface's anchored parts, in reading order"
  ).toEqual(["trends-section-starred", "trends-section-body"]);
  expect(parts[parts.length - 1], "the census reads last").toBe(
    "trends-section-body"
  );
  // The digest renders only when something moved, so it is asserted positionally
  // rather than for presence: when it is there, it heads the surface.
  const digest = order.indexOf("trending-digest");
  if (digest !== -1) {
    expect(digest, "the digest heads the surface when it renders").toBe(0);
    expect(digest).toBeLessThan(order.indexOf("trends-section-starred"));
  }

  // Both halves really render: the curated grid, and the census's own content.
  await expect(page.getByTestId("saved-tiles")).toBeVisible();
  await expect(page.getByTestId("trends-body")).toBeVisible();
});

test("the census is a section of this surface, reachable by its anchor", async ({
  page,
}) => {
  await page.goto("/trends#body");

  // The anchor every retired `?tab=body` link was rewritten to lands ON the census
  // — the deep-link contract the whole href sweep depends on.
  const section = page.locator("section#body");
  await expect(section).toHaveCount(1);
  await expect(section).toBeInViewport();
  await expect(section.getByTestId("trends-body")).toBeVisible();
});

test("the curated grid stays the only curated area", async ({ page }) => {
  await page.goto("/trends");

  // Curation lives in the grid: its tiles are saved rows, and the picker that adds
  // to them is the grid's, not the census's.
  const grid = page.getByTestId("trends-section-starred");
  await expect(grid.getByTestId("saved-tiles")).toBeVisible();
  await expect(grid.getByTestId("save-trend-picker-toggle")).toBeVisible();
  await expect(grid.getByTestId("save-trend-picker")).not.toBeVisible();
  // The census renders its domain unconditionally and offers no second curation
  // surface — the ★ it honours is written one scroll up (#1643).
  const census = page.getByTestId("trends-section-body");
  await expect(census.getByTestId("saved-tiles")).toHaveCount(0);
  await expect(census.getByTestId("save-trend-picker-toggle")).toHaveCount(0);
  await expect(census.getByTestId("save-trend-picker")).toHaveCount(0);
});

test("the census streams below the head instead of blocking it", async ({
  page,
}) => {
  // Read the raw HTML document (no client JS, no hydration) so what is asserted is
  // what the server flushed, not what React later filled in.
  const response = await page.request.get("/trends");
  expect(response.ok()).toBe(true);
  const html = await response.text();
  // The head, the tab strip, and the census's heading + anchor are in the shell…
  expect(html).toContain('data-testid="trends-overview"');
  expect(html).toContain('data-testid="trends-tabs"');
  expect(html).toContain('data-testid="trends-section-starred"');
  expect(html).toContain('data-testid="trends-section-body"');
  // …and the census content rides the same streamed response (the Suspense
  // boundary flushes it after the head rather than dropping it).
  expect(html).toContain('data-testid="trends-body"');

  // In the browser the streamed census settles into real, readable content.
  await page.goto("/trends");
  await expect(page.getByTestId("trends-section-loading")).toHaveCount(0);
});

test("a stale ?tab=body bookmark lands on this surface, unredirected (#1635)", async ({
  page,
}) => {
  // Both retired names for the census — #1486's vitals and #1644's body — plus the
  // explicit default. None of them is rewritten, and all of them render the census.
  for (const query of ["?tab=body", "?tab=vitals", "?tab=overview"]) {
    await page.goto(`/trends${query}`);
    await expect(page).toHaveURL(new RegExp(`\\/trends\\${query}$`));
    await expect(page.getByTestId("trends-overview")).toBeVisible();
  }
});

test("the shared window drives the head and the census together", async ({
  page,
}) => {
  // One range control at the surface's head, not one per part: a window change
  // re-renders both halves.
  await page.goto("/trends?range=all");
  await expect(page.getByTestId("saved-tiles")).toBeVisible();
  await expect(page.getByTestId("trends-context-label")).toHaveText("All");
});

test("every starred tile shows its whole title, never a mid-word clip (#2523)", async ({
  page,
}) => {
  // The starred grid is the only curated area on this surface, and its tile
  // titles were being HARD-CLIPPED from the `sm:` breakpoint up: `truncate`
  // supplies `overflow: hidden`, `sm:whitespace-normal` re-enabled wrapping, and
  // `sm:text-clip` removed the ellipsis, so a token wider than the ~110px the
  // value leaves it was cut mid-glyph with nothing to signal the loss.
  // `Lipoprotein(a)` rendered as `Lipoprotein(` — and the `(a)` is the entire
  // distinction between Lp(a) and ordinary lipoprotein, so that is a WRONG LABEL,
  // not a truncated one. The seed stars it, which is why this needs no fixture.
  //
  // Measured, not eyeballed: a wrapped-but-whole title has content no wider and
  // no taller than the box it renders into. `scrollWidth`/`scrollHeight` are
  // integers rounded UP from fractional layout, so a 1px allowance is the
  // rounding, not slack (#2505) — the defect this pins overflowed by tens of px.
  await page.goto("/trends");
  const grid = page.getByTestId("trends-section-starred");
  await expect(grid.getByTestId("saved-tiles")).toBeVisible();

  const lpa = grid
    .getByTestId("trend-mini-card")
    .filter({ hasText: "Lipoprotein(a)" });
  // Anchored on the named tile, but asserted over the WHOLE grid: the widest
  // value on a row is what squeezes its neighbour's title, so one tile cannot
  // prove the grid. (A text assertion would prove nothing either way — the DOM
  // always carries the full string; the loss is purely visual, hence measured.)
  await expect(lpa).toHaveCount(1);

  const clipped = await grid
    .getByTestId("trend-mini-header-link")
    .locator("span[title]")
    .evaluateAll((titles) =>
      titles
        .filter(
          (el) =>
            el.scrollWidth > el.clientWidth + 1 ||
            el.scrollHeight > el.clientHeight + 1
        )
        .map(
          (el) =>
            `"${el.getAttribute("title")}" renders ${el.scrollWidth}×${el.scrollHeight} ` +
            `into a ${el.clientWidth}×${el.clientHeight} box`
        )
    );
  expect(clipped, clipped.join("\n")).toEqual([]);
});
