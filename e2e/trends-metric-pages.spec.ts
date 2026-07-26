import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { expectNoClippedContent, followLink } from "./helpers";
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
    // The tab strip collapses into the #1485 F context bar at phone width.
    await expandTrendsContext(page);
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
      page.getByRole("heading", { level: 1, name: "Steps per day" })
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
      page.getByRole("heading", { level: 1, name: "Steps per day" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // The fixture's steps series is THREE recent days, so the trailing 7/30/90-day
    // windows contain the same readings and collapse onto ONE card (#1541) — the
    // page used to render the identical four numbers three times. The card is keyed
    // by the WIDEST window it covers, and says how many readings it summarises.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(1);
    await expect(page.getByTestId("period-stat-90")).toBeVisible();
    await expect(page.getByTestId("period-readings-90")).toContainText(
      "3 readings"
    );

    // #1063 mobile guard, element-level (#1543): nothing on the page may be pushed
    // past the 360px viewport edge. A page-level width comparison can't see this —
    // the app shell clips the overflow away.
    await expectNoClippedContent(page);

    await page.context().close();
  });

  test("windows that really differ still get their own card, and no stat value wraps at phone width", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    // The #1541 measurement viewport: 390px is where a hard grid-cols-3 left 76px
    // of content per cell against a Range row needing ~110px.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/trends/metric/weight");

    // The fixture's two weigh-ins sit 7 and 1 days back: the 7d window holds ONE
    // of them, 30d and 90d hold both — so the collapse is partial and the card
    // count is a real signal rather than a constant.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(2);
    await expect(page.getByTestId("period-stat-7")).toBeVisible();
    await expect(page.getByTestId("period-stat-90")).toBeVisible();

    // No value wraps onto a second line: a wrapped `dd` is ~2× the height of the
    // `dt` beside it, which never wraps. Behavioral, not a pixel budget (#868).
    const rows = page.getByTestId("metric-period-stats").locator("dl > div");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const rowBox = await row.boundingBox();
      const term = await row.locator("dt").boundingBox();
      const value = await row.locator("dd").boundingBox();
      expect(rowBox, "the stat row should be laid out").not.toBeNull();
      expect(term, "the stat label should be laid out").not.toBeNull();
      expect(value, "the stat value should be laid out").not.toBeNull();
      expect(
        value!.height,
        `stat value wrapped onto a second line: ${await row.innerText()}`
      ).toBeLessThan(term!.height * 1.5);
      // …and it stays inside its own cell.
      expect(value!.x + value!.width).toBeLessThanOrEqual(
        rowBox!.x + rowBox!.width + 1
      );
    }

    await page.context().close();
  });
});
