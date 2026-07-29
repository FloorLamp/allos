import { test, expect } from "./fixtures";
import { expectNoClippedContent } from "./helpers";
import { censusRevealed } from "./trends-chrome";

// The Body history table is a desktop record editor. Phones use the tile grid and
// focused metric-detail reading rows, so `view=all` must not resurrect the former
// seven-column horizontal scroller at phone width.
test("Trends → Body stays tiles-only at phone width (#794/#1067)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trends?view=all");
  // The body census streams onto the landing surface (#1644): wait for it to be
  // revealed INTO its section before querying its content.
  await censusRevealed(page, "body", "trends-body");

  await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
  await expect(page.getByTestId("body-history-table")).toBeHidden();
  await expectNoClippedContent(page);
});
