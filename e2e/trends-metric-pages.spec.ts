import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { expectNoClippedContent, followLink, hydratedClick } from "./helpers";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_TRENDS_BODY } from "./fixture-logins";

// Trends → Body sparkline-tile overview + per-metric detail pages, Phase 2 of #1067.
// The Body tab's default mobile view is now a sparkline TILE grid (value + trend +
// sparkline per metric); each tile opens a per-metric detail page at
// /trends/metric/<kind> (the biomarker-view pattern for body metrics), except the
// Sleep tile which links to the dedicated /sleep page. Metric-specific source
// controls live with that detailed chart rather than in the Body overview.
//
// Fixture (#868 hygiene): the SAME dedicated read-only member/profile the Phase 1
// spec seeds (Trends Body (e2e)) — a KNOWN, PARTIAL metric set (Weight + resting-HR,
// Steps, Sleep, HR-daily; NO hydration/BMR/calories/BMI/…), so the present/absent
// tile assertions are deterministic under --repeat-each. Spec navigates + scrolls
// only (no writes).

const PHONE = { width: 360, height: 800 };

test.describe("Trends → Body metric pages (#1067 Phase 2)", () => {
  test("the desktop detail page uses a wide analysis layout without a half-width chart", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/trends/metric/weight");

    const detail = page.getByTestId("metric-detail-page");
    const chart = page.getByTestId("metric-detail-chart");
    const plot = chart.getByTestId("chart-card-plot");
    const summary = page.getByTestId("metric-period-stats");
    const detailBox = await detail.boundingBox();
    const chartBox = await chart.boundingBox();
    const plotBox = await plot.boundingBox();
    const summaryBox = await summary.boundingBox();

    expect(detailBox).not.toBeNull();
    expect(chartBox).not.toBeNull();
    expect(plotBox).not.toBeNull();
    expect(summaryBox).not.toBeNull();
    // Desktop is an analysis canvas, not the old narrow reading column.
    expect(detailBox!.width).toBeGreaterThan(1000);
    // Chart + summary form one opening row, with the chart as the primary column.
    expect(Math.abs(chartBox!.y - summaryBox!.y)).toBeLessThan(4);
    expect(chartBox!.width).toBeGreaterThan(summaryBox!.width);
    // BodyTrendCharts normally lays overview cards out two-up. The detail page's
    // only chart must consume its column rather than leaving a blank sibling.
    expect(plotBox!.width).toBeGreaterThan(chartBox!.width * 0.85);
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);
    const measurementToggle = page.getByTestId("metric-measurement-toggle");
    await expect(page.getByTestId("star-toggle")).toBeVisible();
    await expect(measurementToggle).toHaveText("Log Manually");
    await expect(measurementToggle).toHaveAccessibleName("Log weight manually");

    const headingBox = await page
      .getByRole("heading", { level: 1, name: "Weight" })
      .boundingBox();
    const toggleBox = await measurementToggle.boundingBox();
    expect(headingBox).not.toBeNull();
    expect(toggleBox).not.toBeNull();
    expect(Math.abs(toggleBox!.y - headingBox!.y)).toBeLessThan(8);
    expect(toggleBox!.height).toBeGreaterThanOrEqual(30);

    await hydratedClick(page, measurementToggle);
    await expect(measurementToggle).toHaveAttribute("aria-expanded", "true");
    const desktopMetricDialog = page.getByRole("dialog", {
      name: "Log Weight",
    });
    await expect(desktopMetricDialog).toBeVisible();
    const desktopMetricForm = desktopMetricDialog.getByTestId(
      "measurements-quick-add"
    );
    await expect(desktopMetricForm.locator("#m-weight")).toBeVisible();
    await expect(desktopMetricForm.locator("#m-body-fat")).toHaveCount(0);
    await desktopMetricDialog.getByRole("button", { name: "Close" }).click();
    await expect(desktopMetricDialog).toHaveCount(0);
    await expect(measurementToggle).toHaveAttribute("aria-expanded", "false");

    await page.context().close();
  });

  test("the tile grid is the mobile default and a tile opens its metric page", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends");
    // The chip strip collapses into the #1485 F context bar at phone width.
    await expandTrendsContext(page);
    await expect(page.getByTestId("chart-jump-body")).toBeVisible();

    // The sparkline-tile grid is the default view on mobile.
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    // Present metrics get a tile (the fixture seeds these).
    const stepsTile = page.getByTestId("body-tile-steps");
    await expect(stepsTile).toBeVisible();
    await expect(stepsTile.getByText("Steps", { exact: true })).toBeVisible();
    await expect(
      stepsTile.getByText("Daily Steps", { exact: true })
    ).not.toBeVisible();
    await expect(stepsTile.getByRole("link")).toHaveAttribute(
      "href",
      "/trends/metric/steps"
    );
    await expect(page.getByTestId("body-tile-weight")).toBeVisible();
    // Absent metrics don't render a tile (one has-data gate).
    await expect(page.getByTestId("body-tile-hydration")).toHaveCount(0);
    await expect(page.getByTestId("body-tile-bmr")).toHaveCount(0);

    // Opening the Steps tile lands on its per-metric detail page.
    const stepsLink = stepsTile.getByRole("link");
    await followLink(page, stepsLink, /\/trends\/metric\/steps/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Daily Steps" })
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
    await page.goto("/trends");

    const sleepTile = page.getByTestId("body-tile-sleep");
    await expect(sleepTile).toBeVisible();
    // Strong topics keep their own surface (#1042): Sleep → /sleep, not a metric page.
    await followLink(
      page,
      sleepTile.getByTestId("trend-mini-header-link"),
      /\/sleep$/
    );
    await expect(page.getByTestId("body-tile-sleep")).toHaveCount(0);

    await page.context().close();
  });

  test("source controls live on the metric detail page on mobile", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize(PHONE);
    await page.goto("/trends?view=all");

    // Old all-chart URLs still resolve to the compact tile overview on phones,
    // where the former all-metrics source-control stack is intentionally absent.
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    await expect(page.getByTestId("body-charts-all")).not.toBeVisible();
    await expect(page.getByTestId("source-comparison")).toHaveCount(0);

    // Weight has manual + Health Connect fixture series. Its detail page owns the
    // overlay and authoritative-source picker, beside its chart and readings.
    await followLink(
      page,
      page.getByTestId("body-tile-weight").getByRole("link"),
      /\/trends\/metric\/weight/
    );
    await expect(page.getByTestId("source-comparison")).toBeVisible();
    await expect(page.getByTestId("source-compare-weight")).toBeVisible();
    await expect(page.getByTestId("primary-source-weight")).toBeVisible();
    await expect(page.getByTestId("source-legend-weight")).toContainText(
      "Manual"
    );
    await expect(page.getByTestId("source-legend-weight")).toContainText(
      "Health Connect"
    );
    const sourceComparison = page.getByTestId("source-comparison");
    const sourceTitle = sourceComparison.getByRole("heading", {
      level: 2,
      name: "Compare sources",
    });
    const sourceCopy = sourceComparison.getByText(
      "Choose which source is authoritative for totals and latest values. The chart uses the selected range."
    );
    const sourcePickerControl = page.getByTestId(
      "primary-source-control-weight"
    );
    const [sourceTitleBox, sourceCopyBox, sourcePickerBox] = await Promise.all([
      sourceTitle.boundingBox(),
      sourceCopy.boundingBox(),
      sourcePickerControl.boundingBox(),
    ]);
    expect(sourceTitleBox).not.toBeNull();
    expect(sourceCopyBox).not.toBeNull();
    expect(sourcePickerBox).not.toBeNull();
    expect(sourceTitleBox!.height).toBeLessThan(30);
    expect(sourceCopyBox!.width).toBeGreaterThan(250);
    expect(sourcePickerBox!.y).toBeGreaterThan(
      sourceCopyBox!.y + sourceCopyBox!.height
    );
    const readingsSection = page.getByTestId("metric-readings");
    await expect(readingsSection).toBeVisible();
    const firstReading = readingsSection
      .getByTestId("metric-readings-table")
      .locator("tbody tr")
      .first(); // first-ok: this fixture's newest reading owns the row-layout assertion
    await expect(firstReading).toBeVisible();
    const [readingsHeadingBox, firstReadingBox] = await Promise.all([
      readingsSection
        .getByRole("heading", { level: 2, name: "Readings" })
        .boundingBox(),
      firstReading.boundingBox(),
    ]);
    expect(readingsHeadingBox).not.toBeNull();
    expect(firstReadingBox).not.toBeNull();
    const readingsHeader = readingsSection.getByTestId(
      "metric-readings-header"
    );
    const readingsBody = readingsSection.getByTestId("metric-readings-body");
    const [readingsHeaderStyles, readingsHeadingStyles, sourceTitleStyles] =
      await Promise.all([
        readingsHeader.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            paddingLeft: style.paddingLeft,
            paddingTop: style.paddingTop,
          };
        }),
        readingsSection
          .getByRole("heading", { level: 2, name: "Readings" })
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              color: style.color,
            };
          }),
        sourceTitle.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            color: style.color,
          };
        }),
      ]);
    expect(readingsHeaderStyles).toEqual({
      paddingLeft: "16px",
      paddingTop: "10px",
    });
    expect(readingsHeadingStyles).toEqual(sourceTitleStyles);
    expect(Math.abs(readingsHeadingBox!.x - sourceTitleBox!.x)).toBeLessThan(1);
    const headingToFirstRow =
      firstReadingBox!.y - (readingsHeadingBox!.y + readingsHeadingBox!.height);
    expect(headingToFirstRow).toBeGreaterThanOrEqual(3);
    expect(headingToFirstRow).toBeLessThanOrEqual(5);
    expect(
      await readingsSection.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("0px");
    expect(
      await readingsBody.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("8px");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("8px");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).borderRadius
      )
    ).toBe("0px");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).backgroundColor
      )
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).paddingTop
      )
    ).toBe("0px");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).paddingBottom
      )
    ).toBe("8px");
    const firstReadingMenu = firstReading.getByRole("button", {
      name: "Reading actions",
    });
    const [readingDateBox, readingValueBox, readingMenuBox] = await Promise.all(
      [
        firstReading.locator('[data-card="title"]').boundingBox(),
        firstReading.locator('[data-card="value"]').boundingBox(),
        firstReadingMenu.boundingBox(),
      ]
    );
    expect(readingDateBox).not.toBeNull();
    expect(readingValueBox).not.toBeNull();
    expect(readingMenuBox).not.toBeNull();
    expect(readingMenuBox!.height).toBe(32);
    expect(readingDateBox!.y - firstReadingBox!.y).toBeLessThanOrEqual(6);
    expect(
      Math.abs(readingDateBox!.y - readingValueBox!.y)
    ).toBeLessThanOrEqual(2);
    expect(readingValueBox!.x).toBeGreaterThan(
      readingDateBox!.x + readingDateBox!.width
    );
    await expect(
      firstReading.locator('[data-card="value"] .card-cell-label')
    ).toHaveCount(0);
    const firstReadingMeta = firstReading.locator("td.metric-reading-source");
    await expect(firstReadingMeta).toHaveCSS("justify-content", "flex-start");
    await expect(firstReadingMeta).toHaveCSS("text-align", "left");
    const [sourceLabelBox, sourceValueBox] = await Promise.all([
      firstReadingMeta.getByText("Source", { exact: true }).boundingBox(),
      firstReadingMeta.locator(":scope").evaluate((element) => {
        const text = Array.from(element.childNodes).find(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim()
        );
        if (!text) return null;
        const range = document.createRange();
        range.selectNode(text);
        const box = range.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }),
    ]);
    expect(sourceLabelBox).not.toBeNull();
    expect(sourceValueBox).not.toBeNull();
    expect(sourceValueBox!.x).toBeGreaterThan(sourceLabelBox!.x);
    expect(
      sourceValueBox!.x - (sourceLabelBox!.x + sourceLabelBox!.width)
    ).toBeLessThan(8);
    // Entry is deliberate and metric-scoped: the combined morning-measurements
    // form must not sit open on a detail page or expose unrelated fields.
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);
    const mobileStar = page.getByTestId("star-toggle");
    const mobileLog = page.getByTestId("metric-measurement-toggle");
    const [mobileStarBox, mobileLogBox] = await Promise.all([
      mobileStar.boundingBox(),
      mobileLog.boundingBox(),
    ]);
    expect(mobileStarBox).not.toBeNull();
    expect(mobileLogBox).not.toBeNull();
    expect(mobileStarBox!.width).toBeLessThanOrEqual(40);
    expect(mobileLogBox!.width).toBeLessThanOrEqual(40);
    await expect(mobileLog).toHaveAccessibleName("Log weight manually");
    await expect(mobileLog.locator("svg")).toBeVisible();
    await expect(mobileLog.locator("span")).toBeHidden();
    expect(
      Math.abs(
        mobileStarBox!.y +
          mobileStarBox!.height / 2 -
          (mobileLogBox!.y + mobileLogBox!.height / 2)
      )
    ).toBeLessThan(2);
    await hydratedClick(page, mobileLog);
    await expect(mobileLog).toHaveAccessibleName("Log weight manually");
    await expect(mobileLog).toHaveAttribute("aria-expanded", "true");
    await expect(mobileLog.locator("span")).toBeHidden();
    const metricDialog = page.getByRole("dialog", { name: "Log Weight" });
    await expect(metricDialog).toBeVisible();
    const metricForm = metricDialog.getByTestId("measurements-quick-add");
    await expect(metricForm).toBeVisible();
    await expect(metricForm.locator("#m-weight")).toBeVisible();
    await expect(metricForm.locator("#m-body-fat")).toHaveCount(0);
    await expect(metricForm.locator("#m-resting-hr")).toHaveCount(0);
    await expect(metricForm.locator("#m-systolic")).toHaveCount(0);
    await expectNoClippedContent(page);
    await metricDialog.getByRole("button", { name: "Close" }).click();
    await expect(metricDialog).toHaveCount(0);
    await expect(mobileLog).toHaveAttribute("aria-expanded", "false");

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
      page.getByRole("heading", { level: 1, name: "Daily Steps" })
    ).toBeVisible();
    const latestValue = page.getByTestId("metric-latest-value");
    await expect(latestValue).toHaveText("7,600");
    const latestFontSize = await latestValue.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize)
    );
    const titleFontSize = await page
      .getByRole("heading", { level: 1, name: "Daily Steps" })
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(latestFontSize).toBeGreaterThan(titleFontSize);
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // The chart is the drill-in's primary answer. Secondary period stats follow
    // it, instead of consuming another full card before any plotted data appears.
    const chartBox = await page
      .getByTestId("metric-detail-chart")
      .boundingBox();
    const statsBox = await page
      .getByTestId("metric-period-stats")
      .boundingBox();
    expect(chartBox).not.toBeNull();
    expect(statsBox).not.toBeNull();
    expect(chartBox!.y).toBeLessThan(statsBox!.y);
    await expect(
      page.getByRole("heading", { level: 2, name: "Rolling summary" })
    ).toBeVisible();
    // The fixture's steps series is THREE recent days, so the trailing 7/30/90-day
    // windows contain the same readings and collapse onto ONE card (#1541) — the
    // page used to render the identical four numbers three times. The card is keyed
    // by the WIDEST window it covers, and says how many readings it summarises.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(1);
    await expect(page.getByTestId("period-stat-90")).toBeVisible();
    await expect(page.getByTestId("period-readings-90")).toContainText(
      "3 readings"
    );
    const average = page.getByTestId("period-average-90");
    const supportingValue = page
      .getByTestId("period-stat-90")
      .locator("dd")
      .first(); // first-ok: any supporting value establishes the type-size hierarchy
    const averageFontSize = await average.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize)
    );
    const supportingFontSize = await supportingValue.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).fontSize)
    );
    expect(averageFontSize).toBeGreaterThan(supportingFontSize);

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
