import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { expandTrendsContext } from "./trends-chrome";
import { TAP_FLOOR_PX } from "@/lib/tap-floor-tokens";
import {
  expectAtomicCardPairs,
  expectNoClippedContent,
  followLink,
  hydratedClick,
  settledBoxes,
} from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_TRENDS_BODY,
  E2E_LOGIN_METRIC_FOLD,
  METRIC_FOLD_DUPLICATED_BPM,
  METRIC_FOLD_CLINIC_ONLY_BPM,
  METRIC_FOLD_EXPECTED_READINGS,
  E2E_LOGIN_LONG_RANGE,
  LONG_RANGE_DAYS,
} from "./fixture-logins";

// Trends → Overview → body census sparkline-tile overview + per-metric detail pages, Phase 2 of #1067.
// The body census default mobile view is now a sparkline TILE grid (value + trend +
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

test.describe("Trends → Overview → body census metric pages (#1067 Phase 2)", () => {
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
    const [detailBox, chartBox, plotBox, summaryBox] = await settledBoxes([
      detail,
      chart,
      plot,
      summary,
    ]);
    // Desktop is an analysis canvas, not the old narrow reading column.
    expect(detailBox.width).toBeGreaterThan(1000);
    // Chart + summary form one opening row, with the chart as the primary column.
    expect(Math.abs(chartBox.y - summaryBox.y)).toBeLessThan(4);
    expect(chartBox.width).toBeGreaterThan(summaryBox.width);
    // TrendMetricCharts normally lays overview cards out two-up. The detail page's
    // only chart must consume its column rather than leaving a blank sibling.
    expect(plotBox.width).toBeGreaterThan(chartBox.width * 0.85);
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);
    const measurementToggle = page.getByTestId("metric-measurement-toggle");
    await expect(page.getByTestId("star-toggle")).toBeVisible();
    await expect(measurementToggle).toHaveText("Log Manually");
    await expect(measurementToggle).toHaveAccessibleName("Log weight manually");

    const [headingBox, toggleBox] = await settledBoxes([
      page.getByRole("heading", { level: 1, name: "Weight" }),
      measurementToggle,
    ]);
    expect(Math.abs(toggleBox.y - headingBox.y)).toBeLessThan(8);
    expect(toggleBox.height).toBeGreaterThanOrEqual(30);

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
    // The tab strip collapses into the #1485 F context bar at phone width.
    await expandTrendsContext(page);
    await expect(page.getByTestId("trends-section-body")).toBeVisible();

    // The sparkline-tile grid is the default view on mobile.
    await expect(page.getByTestId("body-metric-tiles")).toBeVisible();
    // Present metrics get a tile (the fixture seeds these).
    const stepsTile = page.getByTestId("body-tile-steps");
    await expect(stepsTile).toBeVisible();
    await expect(stepsTile.getByText("Steps", { exact: true })).toBeVisible();
    await expect(
      stepsTile.getByText("Daily Steps", { exact: true })
    ).not.toBeVisible();
    await expect(
      stepsTile.getByTestId("trend-mini-header-link")
    ).toHaveAccessibleName(/Daily Steps/);
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
    const [sourceTitleBox, sourceCopyBox, sourcePickerBox] = await settledBoxes(
      [sourceTitle, sourceCopy, sourcePickerControl]
    );
    expect(sourceTitleBox.height).toBeLessThan(30);
    expect(sourceCopyBox.width).toBeGreaterThan(250);
    expect(sourcePickerBox.y).toBeGreaterThan(
      sourceCopyBox.y + sourceCopyBox.height
    );
    const readingsSection = page.getByTestId("metric-readings");
    await expect(readingsSection).toBeVisible();
    const firstReading = readingsSection
      .getByTestId("metric-readings-table")
      .locator("tbody tr")
      .first(); // first-ok: this fixture's newest reading owns the row-layout assertion
    await expect(firstReading).toBeVisible();
    const [readingsHeadingBox, firstReadingBox] = await settledBoxes([
      readingsSection.getByRole("heading", { level: 2, name: "Readings" }),
      firstReading,
    ]);
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
    // THE HORIZONTAL NUMBERS HERE ARE ZERO ON PURPOSE (#3673), and this is the
    // claim rather than a loosened one. Below `sm` no card draws a frame: the
    // delegated gutters (`card-gutter-standard` 16px on the header,
    // `card-gutter-compact` 8px on the body) and the readings row's own 8px inset
    // were the layer that held this page's text at 24–32px while an unframed
    // neighbour's sat at 16, and the ruling is that the page has ONE left edge.
    // The VERTICAL rhythm is untouched, which is why `paddingTop` still reads 10:
    // a tier that stepped both halves now steps only the one the ruling is about.
    // Do not "restore" the 16 — it is the pre-sweep arrangement, and desktop keeps
    // it (every declaration is `max-sm:`-scoped; see the compiled-CSS proof in
    // lib/__tests__/phone-only-compiled-css.test.ts).
    expect(readingsHeaderStyles).toEqual({
      paddingLeft: "0px",
      paddingTop: "10px",
    });
    expect(readingsHeadingStyles).toEqual(sourceTitleStyles);
    expect(Math.abs(readingsHeadingBox.x - sourceTitleBox.x)).toBeLessThan(1);
    const headingToFirstRow =
      firstReadingBox.y - (readingsHeadingBox.y + readingsHeadingBox.height);
    expect(headingToFirstRow).toBeGreaterThanOrEqual(3);
    expect(headingToFirstRow).toBeLessThanOrEqual(5);
    expect(
      await readingsSection.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("0px");
    // Both were 8px before #3673 — the body's `card-gutter-compact` and the
    // readings row's own `max-sm:pl-2!`, each a smaller gutter inside the card's
    // 16px one. With the card's gone they were the only inset left, so the row's
    // override was deleted and the delegated gutter steps to zero with the rest.
    expect(
      await readingsBody.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("0px");
    expect(
      await firstReading.evaluate(
        (element) => getComputedStyle(element).paddingLeft
      )
    ).toBe("0px");
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
    const [readingDateBox, readingValueBox, readingMenuBox] =
      await settledBoxes([
        firstReading.locator('[data-card="title"]'),
        firstReading.locator('[data-card="value"]'),
        firstReadingMenu,
      ]);
    expect(readingMenuBox.height).toBe(32);
    expect(readingDateBox.y - firstReadingBox.y).toBeLessThanOrEqual(6);
    expect(Math.abs(readingDateBox.y - readingValueBox.y)).toBeLessThanOrEqual(
      2
    );
    expect(readingValueBox.x).toBeGreaterThan(
      readingDateBox.x + readingDateBox.width
    );
    await expect(
      firstReading.locator('[data-card="value"] .card-cell-label')
    ).toHaveCount(0);
    // THE READINGS TAKE THE SHARED PRIMITIVE (#3499). This list used to lay its
    // meta cells out itself — a full-width row with the label pinned left and the
    // value pushed right by `justify-between`, plus a `metric-reading-source`
    // class to undo that for the one cell it did not suit. All of it is gone: the
    // `table-cards` base now renders every card-mode meta cell as one atomic
    // label-value pair, and the metric readings adopt it like every other
    // consumer, so there is no metric-specific meta styling left to assert.
    //
    // What is asserted instead is the SHARED guarantee, measured the same way and
    // with the same discriminator the substrate spec uses
    // (e2e/responsive-tables.mobile.spec.ts): the value's first line box shares a
    // line with its own label, over a corpus the scan is required to have seen —
    // and a break forged on purpose has to be flagged, or the clean sweep proves
    // nothing.
    await expectAtomicCardPairs(readingsBody, ["Source"]);
    // Entry is deliberate and metric-scoped: the combined morning-measurements
    // form must not sit open on a detail page or expose unrelated fields.
    await expect(page.getByTestId("measurements-quick-add")).toHaveCount(0);
    const mobileStar = page.getByTestId("star-toggle");
    const mobileLog = page.getByTestId("metric-measurement-toggle");
    const [mobileStarBox, mobileLogBox] = await settledBoxes([
      mobileStar,
      mobileLog,
    ]);
    // THIS PAIR IS THE ROW #3529's GEOMETRY PROBE FOUND, and the assertion is
    // rewritten around what it actually meant.
    //
    // It used to read `<= 40` on each width, where 40 was the tap floor doubling
    // as "compact, i.e. icon-only rather than labeled". Both controls now render
    // 44, because #3514 ruled ONE tap floor at 44 effective — so the old ceiling
    // was the previous floor written down as a maximum. And while it held, this
    // row was a 40px log toggle beside a 36px star: two control heights in one
    // row, #3486's own defect shape, on a surface #3486's fix had shipped to. The
    // ceiling passed the entire time, because it never asked the two to AGREE.
    //
    // So each meets the floor, the two are equal to each other, and the
    // compactness the old ceiling was really guarding is kept as a separate,
    // looser bound: the labeled variant from `sm` up is far wider, so 48
    // distinguishes icon-only from labeled without pinning anyone's padding.
    for (const box of [mobileStarBox, mobileLogBox]) {
      expect(box.width).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(box.height).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
      expect(box.width).toBeLessThanOrEqual(48);
    }
    expect(mobileStarBox.height).toBe(mobileLogBox.height);
    expect(mobileStarBox.width).toBe(mobileLogBox.width);
    await expect(mobileLog).toHaveAccessibleName("Log weight manually");
    await expect(mobileLog.locator("svg")).toBeVisible();
    await expect(mobileLog.locator("span")).toBeHidden();
    expect(
      Math.abs(
        mobileStarBox.y +
          mobileStarBox.height / 2 -
          (mobileLogBox.y + mobileLogBox.height / 2)
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
    const [chartBox, statsBox] = await settledBoxes([
      page.getByTestId("metric-detail-chart"),
      page.getByTestId("metric-period-stats"),
    ]);
    expect(chartBox.y).toBeLessThan(statsBox.y);
    await expect(
      page.getByRole("heading", { level: 2, name: "Rolling summary" })
    ).toBeVisible();
    // The windows cover COMPLETE days (#1909): they end yesterday, so today's
    // still-accumulating step count never sits inside its own average. The note
    // says so rather than leaving the exclusion to be inferred from a date range.
    await expect(page.getByTestId("metric-period-coverage")).toContainText(
      "through yesterday"
    );
    // The fixture's steps series is three consecutive days ending TODAY, so the
    // summary covers the two complete ones — and the trailing 7/30/90/365-day
    // windows contain the same readings and collapse onto ONE card (#1541); the
    // page used to render the identical four numbers several times. The card is
    // keyed by the WIDEST window it covers (365 since #1938), and says how many
    // readings it summarises.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(1);
    await expect(page.getByTestId("period-stat-365")).toBeVisible();
    await expect(page.getByTestId("period-readings-365")).toContainText(
      "2 readings"
    );
    // Recency is today's job: the card's Latest is today's 7,600, the same value
    // the page hero shows — while the average beside it (8,650) is history's.
    await expect(page.getByTestId("period-stat-365")).toContainText("7,600");
    await expect(page.getByTestId("period-average-365")).toHaveText("8,650");
    const average = page.getByTestId("period-average-365");
    const supportingValue = page
      .getByTestId("period-stat-365")
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

  // #2029. The chart's fold and the readings table under it are two views of ONE
  // day, and they used to disagree: on a day whose clinic-measured value equalled
  // the wearable's, the fold dropped the observation (one plotted point) while the
  // table concatenated it back in (two listed rows). This is that page, on its own
  // fixture, held to one answer.
  test("the chart and the readings table agree about a duplicated day", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_METRIC_FOLD,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/trends/metric/resting-hr");

    const chart = page.getByTestId("metric-detail-chart");
    await expect(chart).toBeVisible();
    const rows = page.getByTestId("metric-readings-table").locator("tbody tr");

    // One number, reached two ways. The equal-valued clinic copy is in NEITHER.
    await expect(chart).toHaveAttribute(
      "data-points",
      String(METRIC_FOLD_EXPECTED_READINGS)
    );
    await expect(rows).toHaveCount(METRIC_FOLD_EXPECTED_READINGS);

    // Exactly ONE row is a clinical record: the reading the stream never saw. The
    // duplicated day's clinic copy is gone from the table, as it always was from
    // the plot — that asymmetry was the bug.
    const observed = rows.filter({
      has: page.getByTestId("metric-reading-observed"),
    });
    await expect(observed).toHaveCount(1);
    // Its own value, plus whatever range tag the clinical record carries — the
    // reading is asserted, not the badge beside it.
    await expect(observed.locator('[data-card="value"]')).toContainText(
      `${METRIC_FOLD_CLINIC_ONLY_BPM} bpm`
    );
    // …and the duplicated value appears once across the whole table, from the
    // wearable row that already answered for that day.
    await expect(
      rows.locator('[data-card="value"]', {
        hasText: new RegExp(`^${METRIC_FOLD_DUPLICATED_BPM} bpm`),
      })
    ).toHaveCount(1);

    await page.context().close();
  });

  // #1938: past 90 days the app used to offer only raw "All time", which on a
  // daily-cadence metric is the unreadable point-per-day scribble #1932 documents.
  // The 1Y quick range must instead render the shared long-range aggregation:
  // weekly means, a low–high band, and the caption that says so — while the 90D
  // default keeps plotting raw points, because a short window was never the
  // problem.
  test("the 1Y range renders an aggregated weekly chart on a daily-cadence metric, and 90D stays raw", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_LONG_RANGE,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto("/trends/metric/weight");

    const chart = page.getByTestId("metric-detail-chart");
    await expect(chart).toBeVisible();
    // The default 90D window: dense (a reading per complete day) but short — the
    // raw plot, with no aggregation caption and no band.
    await expect(page.getByTestId("chart-long-range-note")).toHaveCount(0);
    await expect(chart.locator(".recharts-area")).toHaveCount(0);

    // The 1Y pill is part of the shared quick-range row and lights like any other.
    const oneYearPill = page.getByRole("link", { name: "1Y", exact: true });
    await followLink(page, oneYearPill, /from=/);
    await expect(oneYearPill).toHaveAttribute("aria-current", "true");

    // The full daily series is in the window (`data-points` counts the fold's raw
    // readings)…
    await expect(chart).toHaveAttribute("data-points", String(LONG_RANGE_DAYS));
    // …but the plot is the aggregate: a spread band behind the mean line, and the
    // caption naming the grain — a summary chart, not a 240-point scribble.
    await expect(chart.locator(".recharts-area")).toHaveCount(1);
    const note = page.getByTestId("chart-long-range-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("Weekly averages");

    // With ~8 months of daily history every rolling window genuinely differs, so
    // the #1938 365d column earns its own card alongside 7/30/90.
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(4);
    await expect(page.getByTestId("period-readings-365")).toContainText(
      `${LONG_RANGE_DAYS} readings`
    );

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

    // The fixture's two weigh-ins sit 9 and 1 days back: the 7d window (yesterday
    // back through today−7, complete days only per #1909) holds ONE of them, while
    // 30d, 90d and 365d hold both — so the collapse is partial and the card count
    // is a real signal rather than a constant. The merged run is keyed by its
    // widest window (365 since #1938).
    await expect(page.locator('[data-testid^="period-stat-"]')).toHaveCount(2);
    await expect(page.getByTestId("period-stat-7")).toBeVisible();
    await expect(page.getByTestId("period-stat-365")).toBeVisible();

    // The compound card owns the phone topology: header and grid are its direct
    // parts, and each summary cell is a direct grid child with the one standard
    // gutter. Measure the adjacent boxes at the viewport that exposed the old
    // double-gutter defect; class strings cannot prove a wrapper stayed absent.
    const summary = page.getByTestId("metric-period-stats");
    const grid = summary.locator('[data-delegated-card-part="grid"]');
    expect(
      await summary.evaluate((card) =>
        Array.from(card.children).map((child) =>
          child.getAttribute("data-delegated-card-part")
        )
      )
    ).toEqual(["header", "grid"]);
    expect(
      await grid.evaluate((element) =>
        Array.from(element.children).map((child) =>
          child.getAttribute("data-delegated-card-part")
        )
      )
    ).toEqual(["cell", "cell"]);
    const firstCell = page.getByTestId("period-stat-7");
    const secondCell = page.getByTestId("period-stat-365");
    const [summaryBox, headerBox, gridBox, firstCellBox, secondCellBox] =
      await settledBoxes([
        summary,
        summary.getByTestId("metric-period-stats-header"),
        grid,
        firstCell,
        secondCell,
      ]);
    const summaryFrame = await summary.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderLeft: Number.parseFloat(style.borderLeftWidth),
        borderRight: Number.parseFloat(style.borderRightWidth),
        paddingLeft: Number.parseFloat(style.paddingLeft),
      };
    });
    // THE FRAME IS GONE AT THIS VIEWPORT (#3673), and the topology claim outlives
    // it. This block used to read the card's border and then prove the header and
    // the grid were inset by exactly that border and nothing more — the way to say
    // "no wrapper crept in" when there was a frame to be inset by. Below `sm` there
    // is no border, so the same property is now the simpler statement it always
    // reduced to: both parts start at their container's own x, and the grid spans
    // its full width. The border is still READ, and asserted at zero, so this test
    // still fails if a frame comes back on a phone rather than going quiet about it.
    expect(summaryFrame.borderLeft).toBe(0);
    expect(summaryFrame.borderRight).toBe(0);
    expect(headerBox.x).toBe(summaryBox.x);
    expect(gridBox.x).toBe(summaryBox.x);
    expect(gridBox.width).toBe(
      summaryBox.width - summaryFrame.borderLeft - summaryFrame.borderRight
    );
    expect(firstCellBox.x).toBeCloseTo(gridBox.x, 0);
    expect(secondCellBox.x).toBeCloseTo(gridBox.x, 0);
    expect(firstCellBox.width).toBeCloseTo(secondCellBox.width, 0);
    expect(secondCellBox.y - (firstCellBox.y + firstCellBox.height)).toBe(0);
    expect(summaryFrame.paddingLeft).toBe(0);
    // The standard delegated gutter, which is 16px from `sm` up and zero below it
    // (#3673): a card that spends no inline gutter cannot delegate one either, or
    // the layer simply reappears one level in. Read per cell, because "the grid
    // has no inset" would also pass if only one cell had lost its own.
    for (const cell of [firstCell, secondCell]) {
      expect(
        await cell
          .locator('[data-delegated-card-gutter="standard"]')
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).paddingLeft)
          )
      ).toBe(0);
    }

    // No value wraps onto a second line: a wrapped `dd` is ~2× the height of the
    // `dt` beside it, which never wraps. Behavioral, not a pixel budget (#868).
    const rows = page.getByTestId("metric-period-stats").locator("dl > div");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const [rowBox, term, value] = await settledBoxes([
        row,
        row.locator("dt"),
        row.locator("dd"),
      ]);
      expect(
        value.height,
        `stat value wrapped onto a second line: ${await row.innerText()}`
      ).toBeLessThan(term.height * 1.5);
      // …and it stays inside its own cell.
      expect(value.x + value.width).toBeLessThanOrEqual(
        rowBox.x + rowBox.width + 1
      );
    }

    await page.context().close();
  });
});
