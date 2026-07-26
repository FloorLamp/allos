import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_BODY } from "./fixture-logins";

// Trends → Body mobile overhaul, Phase 1 of #1067. On mobile the tab used to force
// scrolling past three quick-add forms and a fixed single-column chart stack before
// the metric you wanted. Phase 1 (no route change):
//   1. (retired by #1486 — the three quick-adds merged into one form; see
//      e2e/trends-body-merge.mobile.spec.ts)
//   2. sticky chart-jump chips (one overflow-x-auto row) scroll to a chart,
//   3. per-chart `#id` anchors land ON the chart,
//   4. present-only charts are ordered by relevance and their chips render from the
//      SAME visible list, so a chartless metric's chip is hidden.
//
// Fixture (#868 hygiene): a dedicated read-only member/profile (Trends Body (e2e))
// seeded with a KNOWN, PARTIAL metric set (weight+HR, steps, sleep, HR-daily —
// but NO hydration/BMR/calories/…), so the present/absent chip assertions are
// deterministic under --repeat-each. The spec only navigates + scrolls (no writes).

const PHONE = { width: 360, height: 800 };

async function openBodyTab(
  page: Page,
  opts: { view?: "all" | "tiles" } = {}
): Promise<void> {
  // #1067 Phase 2 made TILES the mobile default; the sticky jump chips + the
  // per-chart anchors now live in the classic chart stack (`view=all`), so a test
  // that asserts them opens the Body tab in that layout explicitly.
  const q = opts.view
    ? `/trends?tab=body&view=${opts.view}`
    : "/trends?tab=body";
  await page.goto(q);
  // The tab strip collapses into the #1485 F context bar below `sm`, and this
  // helper drives a phone viewport — open the bar before reading the lit tab.
  await expandTrendsContext(page);
  await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
    "aria-selected",
    "true"
  );
}

test.describe("Trends → Body mobile (#1067 Phase 1)", () => {
  // The former "quick-adds collapse to a chip row" test retired with the chip row
  // itself (#1486): the three quick-adds merged into ONE "Log measurements" form,
  // hidden behind a desktop "+ Log" expander and absent from the phone entirely
  // (the #1468 overlay is the mobile path). That behaviour is covered by
  // e2e/trends-body-merge.mobile.spec.ts, which owns the merged tab.

  test("chart-jump chips render present metrics only and scroll to the chart", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await openBodyTab(page, { view: "all" });

    const jumpRow = page.getByTestId("chart-jump-chips");
    await expect(jumpRow).toBeVisible();

    // Present metrics get a chip (the fixture seeds these).
    await expect(page.getByTestId("chart-jump-body-composition")).toBeVisible();
    await expect(page.getByTestId("chart-jump-steps")).toBeVisible();
    await expect(page.getByTestId("chart-jump-sleep")).toBeVisible();
    await expect(page.getByTestId("chart-jump-hr")).toBeVisible();

    // ONE predicate drives chip + chart: a chartless metric has no chip.
    await expect(page.getByTestId("chart-jump-hydration")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-bmr")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-calories")).toHaveCount(0);

    // The chip row is its OWN horizontal scroll container (#1063) and the page
    // body itself does not scroll sideways at 360px.
    const bodyNoHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(bodyNoHScroll).toBe(true);

    // Tapping a chip scrolls its chart into view (plain in-page `#id` anchor).
    const sleepTile = page.getByTestId("sleep-summary-tile");
    await expect(sleepTile).not.toBeInViewport();
    await page.getByTestId("chart-jump-sleep").click();
    await expect(sleepTile).toBeInViewport();
  });

  test("a per-chart #id anchor lands on the chart on load", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);

    // Deep-link straight to the HR chart — the anchor resolves to the card. The
    // per-chart anchors live in the classic chart stack (view=all) since #1067
    // Phase 2 made tiles the mobile default.
    await page.goto("/trends?tab=body&view=all#hr");
    // The tab strip is collapsed behind the #1485 F context bar at this width, and
    // EXPANDING it here would move the page under the anchor — so the landing is
    // confirmed by the bar's own label, which names the tab without touching layout.
    await expect(page.getByTestId("trends-context-label")).toContainText(
      "Body"
    );
    await expect(page.locator("#hr")).toBeInViewport();

    // And the sleep anchor lands on the sleep tile.
    await page.goto("/trends?tab=body&view=all#sleep");
    await expect(page.getByTestId("sleep-summary-tile")).toBeInViewport();

    await page.context().close();
  });

  // The #1083 vitals focus deep-link moved with the form (#1486): on a phone it now
  // opens the #1468 quick-entry overlay rather than expanding an inline collapse.
  // Covered by e2e/trends-body-merge.mobile.spec.ts.
});
