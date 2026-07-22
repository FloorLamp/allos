import { test, expect } from "@playwright/test";

// Issue #794 (cluster 6): wide tables must WRAP-AND-SCROLL on a phone, not clip.
// The app's main content is `overflow-x-clip`, so a table wider than a narrow
// viewport would silently lose its rightmost columns — the data unreachable, no
// scrollbar. Every table now lives in a horizontal-scroll container (an
// `overflow-x-auto` div / `<ScrollFade>`). This pins the Trends → Body history
// table (7 columns: Date, Weight, [Body fat], Resting HR, Source, Notes, actions)
// as horizontally scrollable — not clipped — at a phone width, guarding the
// wrapper against a regression that would re-hide columns.
test("Trends → Body history table scrolls horizontally at phone width (#794)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // #1067 Phase 2 made TILES the phone default; the history table lives in the
  // classic chart stack, so open it explicitly (view=all) — the table's
  // scroll-not-clip contract at phone width is unchanged.
  await page.goto("/trends?tab=body&view=all");

  const table = page.getByTestId("body-history-table");
  await expect(table).toBeVisible();

  // The scroll container is the table's parent (the ScrollFade / overflow-x-auto
  // div). At 390px the 7-column table overflows it, so content is reachable by
  // scrolling rather than clipped.
  const metrics = await table.evaluate((el) => {
    const container = el.parentElement as HTMLElement;
    const style = getComputedStyle(container);
    // Drive a real horizontal scroll and read back where it landed.
    container.scrollLeft = 9999;
    const scrolledTo = container.scrollLeft;
    return {
      overflowX: style.overflowX,
      scrollWidth: container.scrollWidth,
      clientWidth: container.clientWidth,
      scrolledTo,
    };
  });

  // The container is a horizontal-scroll box…
  expect(metrics.overflowX).toBe("auto");
  // …the table genuinely overflows the phone-width viewport…
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
  // …and scrollLeft is mutable, so the clipped-off columns are reachable by swipe.
  expect(metrics.scrolledTo).toBeGreaterThan(0);
});
