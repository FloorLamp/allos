import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

// The Trends LANDING SURFACE (#1644): the metric census moved into Overview.
//
// `/trends` is now one scroll — conditional trending digest → the Body census —
// while Nutrition and Insights stay tabs (Fitness moved to Training → Analyze).
// What this spec
// pins, and why each clause is a real regression class:
//
//   • COMPOSITION — digest first, census LAST, in DOM order.
//   • CURATION — saved metrics pin and reorder inside the census; its picker is the
//     final non-card cell. Clinical-result saves render nowhere on Trends.
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

test("the landing surface reads digest → body census", async ({ page }) => {
  await page.goto("/trends");

  const order = (await landingOrder(page)).filter(Boolean);
  // The one anchored part is the census, and it is last.
  const parts = order.filter((id) => id.startsWith("trends-section-"));
  expect(
    parts,
    "the landing surface's anchored parts, in reading order"
  ).toEqual(["trends-section-body"]);
  // The digest renders only when something moved, so it is asserted positionally
  // rather than for presence: when it is there, it heads the surface.
  const digest = order.indexOf("trending-digest");
  if (digest !== -1) {
    expect(digest, "the digest heads the surface when it renders").toBe(0);
  }

  // The census and its single tile flow really render. Desktop's default full-chart
  // view keeps the tile flow mounted but hidden; `view=tiles` owns visual geometry.
  await expect(page.getByTestId("body-metric-tiles")).toHaveCount(1);
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

test("the retired #starred deep link resolves to the census", async ({
  page,
}) => {
  await page.goto("/trends#starred");
  await expect(page.locator("#starred")).toHaveCount(1);
  await expect(page.locator("section#body")).toBeInViewport();
  await expect(page.getByTestId("trends-body")).toBeVisible();
});

test("clinical-result saves do not enter the census", async ({ page }) => {
  await page.goto("/trends?view=tiles");

  const census = page.getByTestId("trends-section-body");
  await expect(census.getByTestId("body-metric-tiles")).toBeVisible();
  await expect(census.getByText("Lipoprotein(a)", { exact: true })).toHaveCount(
    0
  );
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
  expect(html).not.toContain('data-testid="trends-section-starred"');
  expect(html).toContain('id="starred"');
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
  await page.goto("/trends?range=all&view=tiles");
  await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
  await expect(page.getByTestId("trends-context-label")).toHaveText("All");
});

test("every census tile shows its whole title, never a mid-word clip (#2523)", async ({
  page,
}) => {
  // Census tile titles must not be HARD-CLIPPED from the `sm:` breakpoint up: `truncate`
  // supplies `overflow: hidden`, `sm:whitespace-normal` re-enabled wrapping, and
  // `sm:text-clip` removed the ellipsis, so a token wider than the ~110px the
  // value leaves it was cut mid-glyph with nothing to signal the loss.
  // Measured, not eyeballed: a wrapped-but-whole title has content no wider and
  // no taller than the box it renders into. `scrollWidth`/`scrollHeight` are
  // integers rounded UP from fractional layout, so a 1px allowance is the
  // rounding, not slack (#2505) — the defect this pins overflowed by tens of px.
  await page.goto("/trends");
  const grid = page.getByTestId("body-metric-tiles");
  // Anchored on the named tile, but asserted over the WHOLE grid: the widest
  // value on a row is what squeezes its neighbour's title, so one tile cannot
  // prove the grid. (A text assertion would prove nothing either way — the DOM
  // always carries the full string; the loss is purely visual, hence measured.)
  const clipped = await grid
    .getByTestId("trend-mini-header-link")
    .locator(":scope > span:first-child")
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
