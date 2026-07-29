import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";

// Trends is ONE scrollable page (#1644) — the successor to e2e/trends-per-tab.spec.ts.
//
// What #105 pinned there was "render only the ACTIVE tab": each tab was a URL
// navigation and the other tabs' content had to be absent. That contract is gone
// with the strip. What replaces it, and what this spec pins:
//
//   • COMPOSITION — the digest heads the page, the starred grid follows, then the
//     Body / Fitness / Nutrition censuses and a closing Insights section, in that
//     DOM order. Section order is the reading order; nothing else says it.
//   • NAVIGATION — the jump chips are the page's navigation, one per section, each
//     a plain in-page anchor to that section's `#id` (so it works pre-hydration and
//     with JS off), and the anchor commits to the URL.
//   • STREAMING — the censuses arrive through Suspense BELOW the head, so their
//     anchors and headings are in the first byte while their content follows. The
//     browser tier is where "it actually renders after streaming" can be seen at all.
//   • NO `?tab=` — the param died with the strip (#1635, no shim). An old bookmark
//     carrying one is not a redirect and not an error: it is ignored, and the page
//     it lands on contains every former tab.
//
// Fixture (#868 hygiene): READ-ONLY over the shared seed — navigation and anchors
// only, nothing written, no shared-seed row exact-counted, so it is repeat-safe.

// Data-independent markers: each section's chrome renders these regardless of what
// the profile has logged.
const SECTION_MARKER: Record<string, string> = {
  body: "trends-body",
  fitness: "trends-fitness",
  nutrition: "nutrition-macros-chart",
};

// The page's direct children, in DOM order, named by testid (sections) — the one
// assertion that can see "the digest is at the head" and "Insights closes" at once.
async function pageOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="trends-page"] > *')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid") ?? el.id ?? "")
    );
}

test("the hub is one page: digest at the head, then the starred grid and every census", async ({
  page,
}) => {
  await page.goto("/trends");

  const order = await pageOrder(page);
  // The sections, in reading order. The digest renders only when something moved,
  // so it is asserted positionally rather than for presence.
  expect(
    order.filter((id) => id.startsWith("trends-section-")),
    "section order on the merged page"
  ).toEqual([
    "trends-section-starred",
    "trends-section-body",
    "trends-section-fitness",
    "trends-section-nutrition",
    "trends-section-insights",
  ]);
  const digest = order.indexOf("trending-digest");
  if (digest !== -1) {
    expect(digest, "the digest heads the page when it renders").toBe(0);
  }

  // Every census actually renders its content — this is the merge's whole claim:
  // what each tab rendered, the page now renders together.
  for (const marker of Object.values(SECTION_MARKER)) {
    await expect(page.getByTestId(marker)).toBeVisible();
  }
  // The starred grid is still the curation surface, and Insights still closes with
  // its compare block.
  await expect(page.getByTestId("saved-tiles")).toBeVisible();
  await expect(page.locator("#compare")).toBeVisible();
});

test("the jump chips are the page navigation — one anchor per section", async ({
  page,
}) => {
  await page.goto("/trends");

  const chips = page.getByTestId("trends-section-chips");
  await expect(chips).toBeVisible();
  await expect(chips.getByRole("link")).toHaveText([
    "Starred",
    "Body",
    "Fitness",
    "Nutrition",
    "Insights",
  ]);

  // Plain in-page anchors: a server-rendered <a href="#id">, so the navigation
  // works before hydration and without JS (the #830 class can't bite it).
  for (const id of ["starred", "body", "fitness", "nutrition", "insights"]) {
    await expect(page.getByTestId(`chart-jump-${id}`)).toHaveAttribute(
      "href",
      `#${id}`
    );
    await expect(page.locator(`section#${id}`)).toHaveCount(1);
  }

  // Tapping one commits the anchor and brings that section into view.
  await page.getByTestId("chart-jump-nutrition").click();
  await expect(page).toHaveURL(/#nutrition$/);
  await expect(page.getByTestId("trends-section-nutrition")).toBeInViewport();
});

test("a census streams in below the head instead of blocking it", async ({
  page,
}) => {
  // The head + every section's anchor and heading are in the FIRST byte; only the
  // census bodies stream. Read the raw HTML document (no client JS, no hydration)
  // so what is asserted is what the server flushed, not what React later filled in.
  const response = await page.request.get("/trends");
  expect(response.ok()).toBe(true);
  const html = await response.text();
  // The shell, the chips and every section anchor arrived…
  expect(html).toContain('data-testid="trends-page"');
  expect(html).toContain('data-testid="trends-section-chips"');
  for (const id of ["starred", "body", "fitness", "nutrition", "insights"]) {
    expect(html, `#${id} anchor in the streamed document`).toContain(
      `data-testid="trends-section-${id}"`
    );
  }
  // …and the census content is part of the same streamed response (Suspense
  // flushes it after the head rather than dropping it).
  expect(html).toContain('data-testid="trends-body"');

  // In the browser the streamed sections settle into real, readable content.
  await page.goto("/trends");
  await expect(page.getByTestId("trends-section-loading")).toHaveCount(0);
  await expect(page.getByTestId("trends-body")).toBeVisible();
});

test("a stale ?tab= bookmark is ignored, not redirected (#1635)", async ({
  page,
}) => {
  // Every retired vocabulary at once: the live tabs, #1486's vitals, #1489's
  // compare, #1164's biomarkers, and #1492's nested ?ftab=. None of them names
  // anything now, so none of them changes what renders — and none of them is
  // rewritten away, because there is no redirect layer.
  for (const query of [
    "?tab=body",
    "?tab=insights",
    "?tab=vitals",
    "?tab=compare",
    "?tab=biomarkers",
    "?ftab=cardio",
  ]) {
    await page.goto(`/trends${query}`);
    await expect(page).toHaveURL(new RegExp(`\\/trends\\${query}$`));
    // A live page carrying the whole hub, not an error and not a fallback view.
    await expect(page.getByTestId("trends-page")).toBeVisible();
    await expect(page.getByTestId("trends-section-chips")).toBeVisible();
    await expect(page.getByTestId("trends-body")).toBeVisible();
  }
});

test("the shared window drives every section at once", async ({ page }) => {
  // One range control at the page head, not one per tab: a window change
  // re-renders the whole page, and the censuses come with it.
  await page.goto("/trends?range=all");
  await expect(page.getByTestId("trends-body")).toBeVisible();
  await expect(page.getByTestId("trends-fitness")).toBeVisible();
  await expect(page.getByTestId("nutrition-macros-chart")).toBeVisible();
  // The chips are page-level, so they survive the window change unchanged.
  await expect(
    page.getByTestId("trends-section-chips").getByRole("link")
  ).toHaveCount(5);
});
