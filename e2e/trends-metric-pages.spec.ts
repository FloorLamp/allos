import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { followLink } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_BODY } from "./fixture-logins";

// Trends → Body sparkline-tile overview + per-metric detail pages, Phase 2 of #1067.
// The Body tab's default mobile view is now a sparkline TILE grid (value + trend +
// sparkline per metric); each tile opens a per-metric detail page at
// /trends/metric/<kind> (the biomarker-view pattern for body metrics), except the
// Sleep tile which links to the dedicated /sleep page. A `view=all` toggle brings
// back the classic full-chart stack.
//
// Fixture (#868 hygiene): the SAME dedicated read-only member/profile the Phase 1
// spec seeds (Trends Body (e2e)) — a KNOWN, PARTIAL metric set (Weight + resting-HR,
// Steps, Sleep, HR-daily; NO hydration/BMR/calories/BMI/…), so the present/absent
// tile assertions are deterministic under --repeat-each. Spec navigates + scrolls
// only (no writes).

const PHONE = { width: 360, height: 800 };

test.describe("Trends → Body metric pages (#1067 Phase 2)", () => {
  test("the tile grid is the mobile default and a tile opens its metric page", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends?tab=body");
    await expect(page.getByRole("tab", { name: "Body" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // The sparkline-tile grid is the default view on mobile.
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    // Present metrics get a tile (the fixture seeds these).
    await expect(page.getByTestId("body-tile-steps")).toBeVisible();
    await expect(page.getByTestId("body-tile-weight")).toBeVisible();
    // Absent metrics don't render a tile (one has-data gate).
    await expect(page.getByTestId("body-tile-hydration")).toHaveCount(0);
    await expect(page.getByTestId("body-tile-bmr")).toHaveCount(0);

    // Opening the Steps tile lands on its per-metric detail page.
    const stepsLink = page.getByTestId("body-tile-steps").getByRole("link");
    await followLink(page, stepsLink, /\/trends\/metric\/steps/);
    await expect(
      page.getByRole("heading", { name: "Steps per day" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();

    await page.context().close();
  });

  test("the Sleep tile links to the dedicated Sleep page, not a metric page", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends?tab=body");

    const sleepTile = page.getByTestId("body-tile-sleep");
    await expect(sleepTile).toBeVisible();
    // Strong topics keep their own surface (#1042): Sleep → /sleep, not a metric page.
    await followLink(page, sleepTile, /\/sleep$/);
    await expect(page.getByTestId("body-tile-sleep")).toHaveCount(0);

    await page.context().close();
  });

  test("view=all preserves the classic full-chart stack (and hides the tiles)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends?tab=body&view=all");

    // The classic stack shows on every viewport under view=all; the tile grid hides.
    await expect(page.getByTestId("body-charts-all")).toBeVisible();
    await expect(page.locator("#steps")).toBeVisible();
    await expect(page.getByTestId("body-metric-tiles")).not.toBeVisible();

    await page.context().close();
  });

  test("a metric detail page renders the chart + period stats and doesn't scroll sideways at phone width", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends/metric/steps");

    await expect(
      page.getByRole("heading", { name: "Steps per day" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // Trailing 7/30/90-day period windows.
    await expect(page.getByTestId("period-stat-7")).toBeVisible();
    await expect(page.getByTestId("period-stat-30")).toBeVisible();
    await expect(page.getByTestId("period-stat-90")).toBeVisible();

    // #1063 mobile guard: the page body must not scroll sideways at 360px.
    const noHScroll = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1
    );
    expect(noHScroll).toBe(true);

    await page.context().close();
  });
});
