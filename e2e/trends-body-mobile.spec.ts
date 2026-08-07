import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { shiftDateStr } from "@/lib/date";
import { loginAs } from "./nav";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";
import { expandTrendsContext } from "./trends-chrome";
import { frozenNow } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_BODY,
  TRENDS_BODY_OLD_DAY,
} from "./fixture-logins";

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
// seeded with a KNOWN, PARTIAL metric set (weight+HR/BMI, steps, sleep, HR-daily —
// but NO hydration/BMR/calories/…), so the present/absent option assertions are
// deterministic under --repeat-each. The spec only navigates + scrolls (no writes).

const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1024, height: 800 };

async function openBodyTab(
  page: Page,
  opts: { view?: "all" | "tiles" } = {}
): Promise<void> {
  const q = opts.view ? `/trends?view=${opts.view}` : "/trends";
  await page.goto(q);
}

test.describe("Trends → Body responsive views (#1067)", () => {
  // The former "quick-adds collapse to a chip row" test retired with that chip row
  // itself (#1486): the three quick-adds merged into ONE "Log measurements" form,
  // hidden behind a desktop "+ Log" modal and absent from the phone entirely
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
    await expect(
      page
        .getByTestId("trends-overview")
        .locator('[data-testid="chart-card-plot"]:visible')
    ).toHaveCount(0);

    // Tiles use the shared range rather than a hidden fixed 30-day window.
    const weightTile = page.getByTestId("body-tile-weight");
    await expect(weightTile).toContainText("77.9 kg");
    const tileHeader = weightTile.getByTestId("trend-mini-header-link");
    const tileBox = await weightTile.boundingBox();
    const tileHeaderBox = await tileHeader.boundingBox();
    expect(tileBox).not.toBeNull();
    expect(tileHeaderBox).not.toBeNull();
    expect(tileHeaderBox!.height).toBeGreaterThanOrEqual(44);
    expect(tileHeaderBox!.width).toBeGreaterThan(tileBox!.width * 0.75);
    // The full chart is one tap away on its metric detail page, never inline on
    // mobile Overview (#2152). Following the header proves the whole tap target;
    // its hover paint is deliberately not part of the phone contract.
    await followLink(page, tileHeader, /\/trends\/metric\/weight/);
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await page.goBack();
    await expect(page.getByTestId("body-tiles-view")).toBeVisible();

    // With the redundant controls gone, the tiles follow the Today card directly
    // without reintroducing horizontal clipping.
    const todayBox = await page.getByTestId("vitals-today-strip").boundingBox();
    const tilesBox = await tiles.boundingBox();
    expect(todayBox).not.toBeNull();
    expect(tilesBox).not.toBeNull();
    if (todayBox && tilesBox) {
      expect(tilesBox.y - (todayBox.y + todayBox.height)).toBeLessThanOrEqual(
        9
      );
    }

    // 1D follows the same phone rule: no full chart exception on Overview.
    await expandTrendsContext(page);
    await followLink(
      page,
      page.getByRole("link", { name: "1D", exact: true }),
      /from=\d{4}-\d{2}-\d{2}.*to=\d{4}-\d{2}-\d{2}/
    );
    const oneDayUrl = new URL(page.url());
    expect(oneDayUrl.searchParams.get("from")).toBe(
      oneDayUrl.searchParams.get("to")
    );
    await expect(page.getByTestId("body-intraday-view")).not.toBeVisible();
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    await expect(
      page
        .getByTestId("trends-overview")
        .locator('[data-testid="chart-card-plot"]:visible')
    ).toHaveCount(0);
    await expectNoClippedContent(page);
  });

  test("range-empty sleep sinks behind populated tiles", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    const yesterday = shiftDateStr(frozenNow().toISOString().slice(0, 10), -1);
    await page.goto(`/trends?from=${yesterday}&to=${yesterday}`);

    const sleep = page.getByTestId("body-tile-sleep");
    await expect(sleep).toContainText("No data in this range");
    await expect(page.getByTestId("body-tile-bmi")).not.toContainText(
      "No data in this range"
    );

    const renderedOrder = await page
      .getByTestId("body-metric-tiles")
      .locator(":scope > div")
      .evaluateAll((items) =>
        items.map(
          (item) =>
            item.firstElementChild?.getAttribute("data-testid") ?? "unknown"
        )
      );
    expect(renderedOrder.indexOf("body-tile-sleep")).toBeGreaterThan(
      renderedOrder.indexOf("body-tile-bmi")
    );
    expect(renderedOrder.indexOf("body-tile-sleep")).toBeGreaterThan(
      renderedOrder.indexOf("body-tile-steps")
    );

    await page.context().close();
  });

  test("historical ranges use their own HR and sleep data", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto(
      `/trends?from=${TRENDS_BODY_OLD_DAY}&to=${TRENDS_BODY_OLD_DAY}`
    );

    await expect(page.getByTestId("body-tile-hr")).toContainText("88 bpm");
    const sleep = page.getByTestId("body-tile-sleep");
    await expect(sleep).toBeVisible();
    await expect(sleep).toContainText("7 h");
    await expect(sleep.getByRole("application")).toBeVisible();
    await expect(sleep.getByTestId("trend-mini-header-link")).toHaveAttribute(
      "href",
      "/sleep"
    );
    const weight = page.getByTestId("body-tile-weight");
    await expect(weight).toContainText("No data in this range");

    const renderedOrder = await page
      .getByTestId("body-metric-tiles")
      .locator(":scope > div")
      .evaluateAll((items) =>
        items.map(
          (item) =>
            item.firstElementChild?.getAttribute("data-testid") ?? "unknown"
        )
      );
    expect(renderedOrder.indexOf("body-tile-weight")).toBeGreaterThan(
      renderedOrder.indexOf("body-tile-hr")
    );
    expect(renderedOrder.indexOf("body-tile-weight")).toBeGreaterThan(
      renderedOrder.indexOf("body-tile-sleep")
    );

    await page.context().close();
  });

  test("desktop tiles keep empty states the same height as populated charts", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(
      `/trends?view=tiles&from=${TRENDS_BODY_OLD_DAY}&to=${TRENDS_BODY_OLD_DAY}`
    );

    const empty = page.getByTestId("body-tile-weight");
    const populated = page.getByTestId("body-tile-sleep");
    await expect(empty).toContainText("No data in this range");
    await expect(populated.getByRole("application")).toBeVisible();
    const emptyHeader = empty.getByTestId("trend-mini-header-link");
    const [emptyTitleBox, emptyMessageBox] = await Promise.all([
      // Responsive title spans intentionally contain the same text for Weight;
      // the desktop form is the second span.
      emptyHeader.getByText("Weight", { exact: true }).last().boundingBox(),
      emptyHeader
        .getByText("No data in this range", { exact: true })
        .boundingBox(),
    ]);
    expect(emptyTitleBox).not.toBeNull();
    expect(emptyMessageBox).not.toBeNull();
    expect(emptyMessageBox!.y).toBeGreaterThanOrEqual(
      emptyTitleBox!.y + emptyTitleBox!.height
    );
    const desktopLabelSize = await emptyHeader
      .getByText("Weight", { exact: true })
      .last()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(desktopLabelSize).toBeGreaterThanOrEqual(16);

    await expect
      .poll(async () => {
        const emptyBox = await empty.boundingBox();
        const populatedBox = await populated.boundingBox();
        if (!emptyBox || !populatedBox) return null;
        return Math.abs(emptyBox.height - populatedBox.height);
      })
      .toBeLessThan(2);

    await page.context().close();
  });

  test("desktop chart menu shares the view-control row and scrolls to a chart", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(DESKTOP);
    await openBodyTab(page);

    const controls = page.getByTestId("body-view-controls");
    const jumpMenu = page.getByTestId("chart-jump-menu");
    const trigger = page.getByTestId("chart-jump-menu-trigger");
    await expect(controls).toContainText("All charts");
    await expect(controls.getByText("Jump to", { exact: true })).toBeVisible();
    await expect(page.getByTestId("body-view-all")).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(page.getByTestId("body-view-tiles")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await expect(jumpMenu).toBeVisible();
    await expect(trigger).toBeVisible();
    await expect(controls.locator("> *")).toHaveCount(3);
    const logButton = controls.getByTestId("log-measurements-toggle");
    await expect(logButton).toBeVisible();
    await expect(logButton).toHaveClass(/btn/);
    await expect(page.getByTestId("chart-jump-chips")).toHaveCount(0);

    // Toggle first, menu second, with matched vertical centers and only the
    // compact 8px control-to-content gap.
    //
    // Read in ONE evaluate (#1644): the census now shares a page with the starred
    // grid above it, whose sparklines settle a little after mount, so five
    // sequential boundingBox() calls could straddle a layout shift and compare
    // rects from different frames. One atomic read makes the geometry claim mean
    // what it says.
    const [viewBox, menuBox, logBox, controlsBox, chartsBox] =
      await page.evaluate(() => {
        const rect = (testId: string) => {
          const el = document.querySelector(`[data-testid="${testId}"]`);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return [
          rect("body-view-toggle"),
          rect("chart-jump-menu"),
          rect("log-measurements-toggle"),
          rect("body-view-controls"),
          rect("body-charts-all"),
        ];
      });
    expect(viewBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(logBox).not.toBeNull();
    expect(controlsBox).not.toBeNull();
    expect(chartsBox).not.toBeNull();
    if (viewBox && menuBox && logBox && controlsBox && chartsBox) {
      expect(
        Math.abs(
          viewBox.x +
            viewBox.width / 2 -
            (controlsBox.x + controlsBox.width / 2)
        )
      ).toBeLessThanOrEqual(1);
      expect(menuBox.x + menuBox.width).toBeLessThan(viewBox.x + 1);
      expect(logBox.x).toBeGreaterThan(viewBox.x + viewBox.width - 1);
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
    const menuOptions = page.getByTestId("chart-jump-menu-options");
    await expect(menuOptions).toBeVisible();
    await expect(menuOptions).toHaveCSS("z-index", "50");

    // The open menu must win the stacking order where it overlaps the first chart.
    const optionsBox = await menuOptions.boundingBox();
    expect(optionsBox).not.toBeNull();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox).not.toBeNull();
    if (optionsBox && triggerBox) {
      expect(Math.abs(optionsBox.x - triggerBox.x)).toBeLessThanOrEqual(1);
      const topmostTestId = await page.evaluate(
        ({ x, y }) =>
          document
            .elementFromPoint(x, y)
            ?.closest<HTMLElement>("[data-testid]")
            ?.getAttribute("data-testid"),
        {
          x: optionsBox.x + optionsBox.width / 2,
          y: Math.min(optionsBox.y + 32, DESKTOP.height - 4),
        }
      );
      expect(topmostTestId).toMatch(/^chart-jump-/);
    }

    // Present metrics get a menu option (the fixture seeds these). Since #1674 the
    // menu lists CARDS rather than section boxes, so each one names a chart.
    await expect(page.getByTestId("chart-jump-weight")).toBeVisible();
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

    // A card fills its own grid cell rather than leaving a vacant strip beside it.
    // Read atomically: the stack shares a page with the starred grid above, whose
    // sparklines settle after mount (#1644).
    const cellWidths = await page.evaluate(() => {
      const stack = document.querySelector('[data-testid="body-chart-stack"]');
      const card = document.querySelector('[data-testid="vitals-resting-hr"]');
      const cell = card?.closest('[data-testid^="body-stack-item-"]');
      if (!stack || !card || !cell) return null;
      return {
        cell: cell.getBoundingClientRect().width,
        card: card.getBoundingClientRect().width,
      };
    });
    expect(cellWidths).not.toBeNull();
    expect(cellWidths!.card).toBeGreaterThan(cellWidths!.cell * 0.9);

    // Selecting an option scrolls its chart into view (plain `#id` anchor).
    const sleepTile = page.getByTestId("sleep-summary-tile");
    await expect(sleepTile).not.toBeInViewport();
    await expect(sleepTile.getByRole("application")).toBeVisible();
    await expect(
      sleepTile.getByTestId("chart-card-header-link")
    ).toHaveAttribute("href", "/sleep");
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

    // Deep-link straight to the desktop HR chart — the anchor resolves to the card,
    // inside the census that streams onto the landing surface (#1644).
    await page.goto("/trends?view=all#hr");
    // The always-visible tab strip names the surface without expanding the range
    // controls and moving the page under the anchor.
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true })
    ).toBeVisible();
    await expect(page.locator("#hr")).toBeInViewport();

    // And the sleep anchor lands on the sleep tile — asserted from a FRESH load,
    // which is what this test is about. A goto that changes only the fragment is
    // not a load: the document stays, so the streamed census is not re-assembled
    // and the on-load alignment this pins would never run. Leave the hub first.
    await page.goto("/timeline");
    await page.goto("/trends?view=all#sleep");
    await expect(page.getByTestId("sleep-summary-tile")).toBeInViewport();

    await page.context().close();
  });

  // The #1083 vitals focus deep-link moved with the form (#1486): on a phone it now
  // opens the #1468 quick-entry overlay rather than expanding an inline collapse.
  // Covered by e2e/trends-body-merge.mobile.spec.ts.
});
