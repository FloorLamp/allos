import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_BODY } from "./fixture-logins";

// Trends → Body responsive layouts. On mobile the tab used to force scrolling past
// three quick-add forms and a fixed single-column chart stack before the metric you
// wanted. The final responsive split:
//   1. (retired by #1486 — the three quick-adds merged into one form; see
//      e2e/trends-body-merge.mobile.spec.ts)
//   2. mobile is tiles-only; the long full-chart stack has no phone entry point,
//   3. desktop keeps an inline chart dropdown beside the layout toggle,
//   4. per-chart `#id` anchors land ON the desktop chart,
//   5. present-only charts are ordered by relevance and the menu renders from the
//      SAME visible list, so a chartless metric has no option.
//
// Fixture (#868 hygiene): a dedicated read-only member/profile (Trends Body (e2e))
// seeded with a KNOWN, PARTIAL metric set (weight+HR, steps, sleep, HR-daily —
// but NO hydration/BMR/calories/…), so the present/absent option assertions are
// deterministic under --repeat-each. The spec only navigates + scrolls (no writes).

const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1024, height: 800 };

async function openBodyTab(
  page: Page,
  opts: { view?: "all" | "tiles" } = {}
): Promise<void> {
  const q = opts.view
    ? `/trends?tab=body&view=${opts.view}`
    : "/trends?tab=body";
  await page.goto(q);
  await expect(
    page.getByRole("tab", { name: "Body", exact: true })
  ).toHaveAttribute("aria-selected", "true");
}

test.describe("Trends → Body responsive views (#1067)", () => {
  // The former "quick-adds collapse to a chip row" test retired with that chip row
  // itself (#1486): the three quick-adds merged into ONE "Log measurements" form,
  // hidden behind a desktop "+ Log" expander and absent from the phone entirely
  // (the #1468 overlay is the mobile path). That behaviour is covered by
  // e2e/trends-body-merge.mobile.spec.ts, which owns the merged tab.

  test("mobile stays tiles-only even when an old all-charts URL is opened", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await openBodyTab(page, { view: "all" });

    const tiles = page.getByTestId("body-tiles-view");
    await expect(tiles).toBeVisible();
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    await expect(page.getByTestId("body-view-controls")).not.toBeVisible();
    await expect(page.getByTestId("body-view-toggle")).not.toBeVisible();
    await expect(page.getByTestId("chart-jump-menu")).not.toBeVisible();
    await expect(page.getByTestId("body-charts-all")).not.toBeVisible();

    // Tiles use the shared range rather than a hidden fixed 30-day window.
    const weightTile = page.getByTestId("body-tile-weight");
    await expect(weightTile).toContainText("77.9 kg");
    await expandTrendsContext(page);
    await followLink(
      page,
      page.getByRole("link", { name: "1D", exact: true }),
      /from=2026-07-26.*to=2026-07-26/
    );
    await expect(weightTile).toContainText("No data in this range");

    // With the redundant controls gone, the tiles start at the panel top without
    // reintroducing horizontal clipping.
    const panelBox = await page.getByRole("tabpanel").boundingBox();
    const tilesBox = await tiles.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(tilesBox).not.toBeNull();
    if (panelBox && tilesBox) {
      expect(tilesBox.y - panelBox.y).toBeLessThanOrEqual(9);
    }
    await expectNoClippedContent(page);
  });

  test("desktop chart menu shares the view-control row and scrolls to a chart", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await openBodyTab(page, { view: "all" });

    const controls = page.getByTestId("body-view-controls");
    const jumpMenu = page.getByTestId("chart-jump-menu");
    const trigger = page.getByTestId("chart-jump-menu-trigger");
    await expect(controls).toContainText("All charts");
    await expect(jumpMenu).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(controls.locator("> *")).toHaveCount(2);
    await expect(page.getByTestId("chart-jump-chips")).toHaveCount(0);

    // Toggle first, menu second, with matched vertical centers and only the
    // compact 8px control-to-content gap.
    const viewBox = await page.getByTestId("body-view-toggle").boundingBox();
    const menuBox = await jumpMenu.boundingBox();
    const controlsBox = await controls.boundingBox();
    const chartsBox = await page.getByTestId("body-charts-all").boundingBox();
    expect(viewBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(chartsBox).not.toBeNull();
    if (viewBox && menuBox && controlsBox && chartsBox) {
      expect(menuBox.x).toBeGreaterThan(viewBox.x + viewBox.width - 1);
      expect(
        Math.abs(
          viewBox.y + viewBox.height / 2 - (menuBox.y + menuBox.height / 2)
        )
      ).toBeLessThanOrEqual(1);
      expect(
        chartsBox.y - (controlsBox.y + controlsBox.height)
      ).toBeLessThanOrEqual(9);
    }

    await hydratedClick(page, trigger);
    await expect(page.getByTestId("chart-jump-menu-options")).toBeVisible();

    // Present metrics get a menu option (the fixture seeds these).
    await expect(page.getByTestId("chart-jump-body-composition")).toBeVisible();
    await expect(page.getByTestId("chart-jump-steps")).toBeVisible();
    await expect(page.getByTestId("chart-jump-sleep")).toBeVisible();
    await expect(page.getByTestId("chart-jump-hr")).toBeVisible();

    // ONE predicate drives menu + chart: a chartless metric has no option.
    await expect(page.getByTestId("chart-jump-hydration")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-bmr")).toHaveCount(0);
    await expect(page.getByTestId("chart-jump-calories")).toHaveCount(0);

    // Element-level (#1543): the shell clips overflow a page-level width
    // comparison would miss.
    await expectNoClippedContent(page);

    // Selecting an option scrolls its chart into view (plain `#id` anchor).
    const sleepTile = page.getByTestId("sleep-summary-tile");
    await expect(sleepTile).not.toBeInViewport();
    await page.getByTestId("chart-jump-sleep").click();
    await expect(sleepTile).toBeInViewport();
    await expect(page.getByTestId("chart-jump-menu-options")).toHaveCount(0);
  });

  test("a per-chart #id anchor lands on the chart on load", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);

    // Deep-link straight to the desktop HR chart — the anchor resolves to the card.
    await page.goto("/trends?tab=body&view=all#hr");
    // The always-visible tab confirms the selected surface without expanding the
    // range controls and moving the page under the anchor.
    await expect(
      page.getByRole("tab", { name: "Body", exact: true })
    ).toHaveAttribute("aria-selected", "true");
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
