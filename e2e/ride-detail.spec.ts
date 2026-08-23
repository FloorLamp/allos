import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import type { Page } from "@playwright/test";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import {
  serializeCyclingStreamSummary,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";

// The Log feed is a slim index. Selecting a ride navigates directly to its
// canonical activity page at every viewport size.
async function openRideRecord(page: Page, title: string) {
  const row = page.getByTestId("training-log-row").filter({ hasText: title });
  await followLink(
    page,
    row.getByRole("link", { name: title, exact: true }),
    /\/training\/activity\/\d+$/
  );
  const record = page
    .getByTestId("training-activity-page")
    .filter({ hasText: title });
  await expect(record).toBeVisible();
  return record;
}

test("a Training Log ride opens a read-first detail with the stored ride measurements", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  await openRideRecord(page, "Strava morning ride");
  await expect(page).toHaveURL(/\/training\/activity\/\d+$/);

  const rideDetail = page.getByTestId("training-activity-page");
  await expect(rideDetail).toBeVisible();
  await expect(rideDetail).toHaveClass(/mx-auto/);
  const detailBox = await rideDetail.boundingBox();
  const contentBox = await page
    .getByTestId("app-content-container")
    .boundingBox();
  expect(detailBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(
    Math.abs(
      detailBox!.x +
        detailBox!.width / 2 -
        (contentBox!.x + contentBox!.width / 2)
    )
  ).toBeLessThanOrEqual(2);
  await expect(page.getByTestId("ride-summary")).toHaveClass(/card/);
  expect(
    await page
      .getByTestId("ride-summary")
      .evaluate(
        (element) => element.closest('[data-testid^="activity-section-"]')?.id
      )
  ).toBe("overview");
  await expect(page.getByTestId("ride-recorded-measurements")).toBeVisible();
  await expect(
    page
      .getByTestId("ride-summary")
      .getByRole("heading", { name: "Recorded measurements" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Strava morning ride", exact: true })
  ).toBeVisible();
  const primarySummary = page
    .getByTestId("ride-summary")
    .getByTestId("ride-summary-line");
  await expect(primarySummary).toContainText("62 min");
  await expect(primarySummary).toContainText("24.5 km");
  await expect(primarySummary).toContainText("148/171 bpm");
  await expect(primarySummary).toContainText("72");
  await expect(primarySummary).toContainText("648 kcal");
  // MAX HEART RATE IS NOT REPEATED HERE (#3500 item 3). This ride's summary line
  // above already reads "148/171 bpm" — the house avg/max composite — so the
  // secondary block no longer states 171 a second time. The branch where the box
  // DOES still render (a max with no average, so the composite cannot carry it)
  // has its own test below.
  await expect(page.getByTestId("ride-stat-max-heart-rate")).toHaveCount(0);
  await expect(page.getByTestId("ride-stat-power")).toContainText("186 W");
  await expect(page.getByTestId("ride-stat-power")).toContainText(
    "193 weighted"
  );
  await expect(page.getByTestId("ride-stat-power")).toContainText("612 max");
  await expect(page.getByTestId("ride-stat-power")).toContainText("W/kg");
  await expect(page.getByTestId("ride-stat-max-speed")).toContainText("41.8");
  await expect(page.getByTestId("ride-stat-elevation")).toContainText("210 m");
  await expect(page.getByTestId("ride-stat-workout-type")).toContainText(
    "Workout"
  );
  await expect(page.getByTestId("ride-stat-cadence")).toContainText("88 rpm");
  await expect(page.getByTestId("ride-stat-kilojoules")).toContainText(
    "692 kJ"
  );
  await expect(page.getByTestId("ride-stat-temperature")).toContainText("18°C");
  await expect(page.getByTestId("activity-gear")).toContainText("Road Bike");
  const highlights = page.getByTestId("session-highlights");
  await expect(highlights).toBeVisible();
  await expect(page.getByTestId("session-highlight-comparison")).toHaveCount(0);
  await expect(
    page.getByTestId("session-highlight-heart-rate-zone")
  ).toContainText("Most time in HR zone");
  await expect(
    page.getByTestId("session-highlight-heart-rate-zone")
  ).toContainText("Zone 2");
  await expect(
    page.getByTestId("session-highlight-segment-results")
  ).toContainText("1 personal best");
  await expect(page.getByTestId("session-highlight-efficiency")).toContainText(
    "drift"
  );
  const comparison = page.getByTestId("ride-comparison");
  // The Zone 2 base ride is one day later than this Strava ride. It still belongs
  // in the full cohort alongside the other earlier and same-day seeded peers.
  await expect(comparison).toContainText("3 similar rides");
  const comparisonChart = page.getByTestId("ride-comparison-chart");
  await expect(
    comparisonChart.getByRole("button", { name: "Speed", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(comparisonChart).toContainText("This ride");
  await expect(comparisonChart).toContainText("Median");
  await expect(
    comparisonChart.getByTestId("ride-comparison-observation")
  ).toHaveCount(4);
  const comparisonTrackBoxes = await comparisonChart
    .getByTestId("ride-comparison-track")
    .evaluateAll((tracks) =>
      tracks.map((track) => {
        const box = track.getBoundingClientRect();
        return { x: box.x, width: box.width };
      })
    );
  expect(comparisonTrackBoxes.length).toBeGreaterThan(1);
  for (const box of comparisonTrackBoxes.slice(1)) {
    expect(Math.abs(box.x - comparisonTrackBoxes[0].x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(box.width - comparisonTrackBoxes[0].width)
    ).toBeLessThanOrEqual(1);
  }
  await expect(comparisonChart.locator('[data-current="true"]')).toContainText(
    "23.7 km/h"
  );
  await expect(comparisonChart.locator('[data-current="true"]')).toContainText(
    "This ride"
  );
  await expect(
    comparisonChart.locator('[data-current="true"]')
  ).not.toContainText("2026");
  await expect(
    comparisonChart.locator('[data-current="true"]').getByRole("link")
  ).toHaveCount(0);
  const comparisonRideLinks = comparisonChart.getByTestId(
    "ride-comparison-link"
  );
  await expect(comparisonRideLinks).toHaveCount(3);
  expect(
    await comparisonRideLinks.evaluateAll((links) =>
      links.every((link) =>
        /^\/training\/activity\/\d+$/.test(link.getAttribute("href") ?? "")
      )
    )
  ).toBe(true);
  await expect(
    comparisonRideLinks.first() // first-ok: the seeded comparison cohort is deterministically ranked
  ).toContainText(/^\w+, \w+ \d{1,2}, 2026/);
  await comparisonChart
    .getByRole("button", { name: "Power", exact: true })
    .click();
  await expect(
    comparisonChart.getByRole("button", { name: "Power", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  const speedComparison = page.getByTestId("ride-summary-comparison-speed");
  await expect(speedComparison).toHaveText("0.3 km/h below 24 km/h median");
  await expect(speedComparison).toHaveClass(/text-amber-700/);
  await expect(page.getByTestId("ride-summary-comparison-power")).toBeVisible();
  // The neutral tone is SLATE (#3500 item 1) — it used to be sky, which at
  // font-medium is this app's most link-like non-link. The tone rule as a whole
  // (nothing sky, speed still directional, both themes) is measured in
  // "the ride comparison deltas read as statements…" below.
  await expect(page.getByTestId("ride-summary-comparison-power")).toHaveClass(
    /text-slate-600/
  );
  await expect(
    page.getByTestId("ride-summary-comparison-weighted-power")
  ).toContainText("Weighted:");
  await expect(
    page
      .getByTestId("ride-comparison")
      .getByRole("heading", { name: "Median comparison" })
  ).toHaveCount(0);
  await expect(page.getByTestId("ride-comparison-table")).toHaveCount(0);
  await expect(page.getByTestId("ride-history")).toHaveCount(0);
  const olderActivityLink = page.getByTestId("activity-older-link");
  const newerActivityLink = page.getByTestId("activity-newer-link");
  await expect(olderActivityLink).toHaveAttribute(
    "href",
    /\/training\/activity\/\d+$/
  );
  await expect(newerActivityLink).toHaveAttribute(
    "href",
    /\/training\/activity\/\d+$/
  );
  await expect(olderActivityLink).toContainText("Older");
  await expect(newerActivityLink).toContainText("Newer");
  await expect(page.getByTestId("activity-ledger-navigation")).toHaveCount(1);
  const route = page.getByTestId("ride-route");
  await expect(route.getByRole("heading", { name: "Route" })).toHaveClass(
    /text-base/
  );
  expect(
    await route.evaluate(
      (element) => element.closest('[data-testid^="activity-section-"]')?.id
    )
  ).toBe("course");
  await expect(route.getByTestId("route-map")).toBeVisible();
  await expect(page.getByTestId("ride-route-history")).toContainText(
    "earlier ride"
  );
  const traces = page.getByTestId("ride-traces");
  expect(
    await traces.evaluate(
      (element) => element.closest('[data-testid^="activity-section-"]')?.id
    )
  ).toBe("effort");
  await expect(traces.getByRole("button", { name: "Power" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  const telemetryChart = page.getByTestId("session-telemetry-chart");
  const telemetrySvg = telemetryChart.locator("svg");
  await expect(telemetrySvg).toBeVisible();
  await expect(page.getByTestId("session-heart-rate-chart")).toBeVisible();
  await expect(route.getByTestId("route-active-point")).toHaveCount(0);
  const telemetryBox = await telemetrySvg.boundingBox();
  expect(telemetryBox).not.toBeNull();
  await telemetrySvg.hover({
    position: {
      x: telemetryBox!.width * 0.55,
      y: telemetryBox!.height * 0.5,
    },
  });
  await expect(route.getByTestId("route-active-point")).toBeVisible();
  await expect(
    telemetryChart.locator(".recharts-tooltip-wrapper")
  ).toBeVisible();
  await expect(
    page
      .getByTestId("session-heart-rate-chart")
      .locator(".recharts-tooltip-wrapper")
  ).toBeVisible();
  await traces.getByRole("button", { name: "Cadence" }).click();
  await expect(traces.getByRole("button", { name: "Cadence" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByTestId("ride-power-profile")).toContainText(
    "20 min best"
  );
  await expect(page.getByTestId("ride-power-profile")).toContainText(
    "Intensity factor"
  );
  await expect(page.getByTestId("ride-power-profile")).toContainText(
    "Strava power zones"
  );
  await expect(page.getByTestId("ride-power-zone-bar")).toBeVisible();
  await expect(page.getByTestId("ride-analysis-stopped")).toContainText("1:00");
  await expect(page.getByTestId("ride-analysis-coasting")).toContainText(
    "1:40"
  );
  await expect(page.getByTestId("ride-analysis-climbing")).toContainText(
    "5:00"
  );
  await expect(page.getByTestId("ride-distance-splits")).toContainText("5 km");
  await expect(page.getByTestId("session-laps")).toContainText("Lap 2");
  await expect(page.getByTestId("session-segments")).toContainText(
    "Fictional park climb"
  );
  await expect(page.getByTestId("session-segments")).toContainText("PR #1");
  expect(
    await page
      .getByTestId("session-segments")
      .evaluate(
        (element) => element.closest('[data-testid^="activity-section-"]')?.id
      )
  ).toBe("course");
  await expect(page.getByTestId("activity-notes-card")).toContainText(
    "steady endurance work"
  );
  await expect(page.getByTestId("activity-provenance")).toContainText("Strava");
  await expect(page.getByTestId("activity-provenance")).toContainText("edited");

  await page.getByTestId("activity-page-edit").click();
  await expect(page.getByTestId("activity-form-header")).toBeVisible();
  await expect(page.getByTestId("imported-activity-details")).toContainText(
    "Recorded measurements"
  );
});

test("the Cycling overview, ride detail, and Timeline form one navigation loop", async ({
  page,
}) => {
  await page.goto(
    "/training?tab=analyze&kind=strength&item=Barbell%20Bench%20Press&range=all"
  );
  const quickAccess = page.getByTestId("analyze-quick-links");
  const quickLinksBefore = await quickAccess
    .getByRole("link")
    .allTextContents();
  await expect(
    quickAccess.getByRole("link", {
      name: "Barbell Bench Press",
      exact: true,
    })
  ).toHaveAttribute("aria-current", "page");
  const quickCyclingLink = quickAccess.getByRole("link", {
    name: "Cycling",
    exact: true,
  });
  await expect(quickCyclingLink).toBeVisible();
  await expect(quickCyclingLink.getByTestId("activity-icon")).toHaveAttribute(
    "data-icon",
    "bike"
  );
  await followLink(page, quickCyclingLink, /kind=cardio&item=Cycling/);
  expect(await quickAccess.getByRole("link").allTextContents()).toEqual(
    quickLinksBefore
  );
  await expect(
    quickAccess.getByRole("link", { name: "Cycling", exact: true })
  ).toHaveAttribute("aria-current", "page");
  const analyze = page.getByTestId("analyze-section");
  await expect(analyze).toBeVisible();
  const cyclingShell = page.getByTestId("cycling-overview");
  await expect(cyclingShell).toBeVisible();
  const activityTitle = cyclingShell.getByRole("combobox", {
    name: "Exercise or activity",
  });
  await expect(activityTitle).toHaveValue("Cycling");
  await expect(activityTitle).toHaveClass(/border-0!/);
  await expect(activityTitle).toHaveClass(/py-1!/);
  await expect(cyclingShell.getByTestId("combobox-title-text")).toHaveText(
    "Cycling"
  );
  await expect(
    cyclingShell
      .getByTestId("analyze-activity-title")
      .getByTestId("activity-icon")
  ).toHaveAttribute("data-icon", "bike");
  expect(
    await activityTitle.evaluate(
      (element) => element.closest('[role="heading"][aria-level="2"]') != null
    )
  ).toBe(true);
  await activityTitle.click();
  // Portaled listbox (#3271): the rows are on <body>, not inside the shell. One
  // list is open at a time, so the page-level count is the same question.
  expect(await page.getByTestId("combobox-option").count()).toBeGreaterThan(1);
  await activityTitle.press("Escape");
  await expect(cyclingShell.getByText("Cycling overview")).toHaveCount(0);
  await expect(
    analyze.getByRole("heading", { name: "Ride progression", exact: true })
  ).toBeVisible();
  await expect(
    analyze.getByRole("heading", { name: "Ride history", exact: true })
  ).toBeVisible();
  await expect(
    analyze.getByRole("heading", { name: "Totals & records", exact: true })
  ).toBeVisible();
  const progression = page.getByTestId("cycling-progression");
  for (const metric of [
    "Distance",
    "Speed",
    "Elevation",
    "Heart rate",
    "Power",
    "Weighted power",
    "Cadence",
    "Effort",
  ]) {
    // The metric picker is a compact select since #2895 — the offered set is
    // its options rather than a row of links. Exact text: "Power" must not
    // count "Weighted power".
    await expect(
      progression
        .getByRole("combobox", { name: "Metric" })
        .getByRole("option", { name: metric, exact: true })
    ).toHaveCount(1);
  }
  await expect(
    cyclingShell
      .getByRole("combobox", { name: "Metric" })
      .getByRole("option", { name: "Distance", exact: true })
  ).toHaveCount(0);
  await expect(page.getByTestId("cycling-totals")).toContainText(
    "Personal records"
  );
  await expect(page.getByTestId("cycling-recent-form")).toContainText(
    "Last 28 days"
  );
  await expect(page.getByTestId("cycling-distribution")).toContainText(
    "Rides by calendar month"
  );
  await expect(page.getByTestId("cycling-distribution")).toContainText(
    "Conditions"
  );
  await expect(page.getByTestId("cycling-heart-rate-zones")).toContainText(
    "Zone 2"
  );
  // The distribution is windowed where the totals above are all-time (#2197), so
  // the card has to say which weeks it counted.
  await expect(page.getByTestId("cycling-heart-rate-zones")).toContainText(
    "over the 12 weeks through"
  );
  // The power cards are the OTHER half of #2197's page: since #2292 they render
  // from the per-ride summary precomputed at ingest rather than from a parse of
  // every stored stream. They stay ALL-TIME where the distribution above is
  // windowed, so this card carries no window sentence — and both a wattage and the
  // zone breakdown have to survive the column change.
  await expect(page.getByTestId("cycling-power-profile")).toContainText(
    "20 min best"
  );
  await expect(page.getByTestId("cycling-power-profile")).toContainText(" W");
  await expect(page.getByTestId("cycling-power-profile")).toContainText(
    "Time in power zones"
  );
  await expect(page.getByTestId("cycling-power-profile")).not.toContainText(
    "over the 12 weeks through"
  );
  await expect(page.getByTestId("cycling-data-coverage")).toContainText(
    "Mapped rides"
  );
  await expect(page.getByTestId("cycling-data-coverage")).toContainText(
    "Segment data"
  );
  await expect(page.getByTestId("cycling-totals")).toContainText(
    "Segment personal bests"
  );
  expect(
    await analyze
      .locator(
        '[data-testid="cycling-progression"], [data-testid="cycling-summary"], [data-testid="cycling-distribution"], [data-testid="cycling-performance"], [data-testid="cycling-ride-history"], [data-testid="cycling-data-coverage"]'
      )
      .evaluateAll((sections) =>
        sections.map((section) => section.getAttribute("data-testid"))
      )
  ).toEqual([
    "cycling-progression",
    "cycling-summary",
    "cycling-distribution",
    "cycling-performance",
    "cycling-ride-history",
    "cycling-data-coverage",
  ]);
  await expect(analyze.getByTestId("analyze-sessions")).toContainText(
    "Heart rate"
  );
  await expect(analyze.getByTestId("analyze-sessions")).toContainText("Power");

  // The metric/range pickers are compact selects since #2895; choosing an
  // option navigates exactly as the old segmented links did.
  await progression.getByRole("combobox", { name: "Metric" }).selectOption({
    label: "Power",
  });
  await page.waitForURL(/metric=power/);
  await expect(analyze).toContainText("Avg power across logged rides");
  await progression.getByRole("combobox", { name: "Range" }).selectOption({
    label: "6m",
  });
  await page.waitForURL(/range=6m/);
  await expect(
    analyze.getByTestId("analyze-sessions").locator("th").nth(1)
  ).toHaveText("Power");
  await expect(
    analyze
      .getByTestId("analyze-sessions")
      .locator('tbody td[data-card="value"]')
      .first() // first-ok: every seeded session value must lead with the selected metric
  ).toContainText("Power");

  const latestRide = analyze.getByRole("link", {
    name: "Latest ride",
    exact: true,
  });
  await expect(latestRide).toHaveAttribute(
    "href",
    /^\/training\/activity\/\d+\?metric=power&range=6m$/
  );
  const powerProfileRide = page
    .getByTestId("cycling-power-profile")
    .getByRole("link")
    .first(); // first-ok: seeded power records are a deterministic duration-ordered set
  await expect(powerProfileRide).toHaveAttribute(
    "href",
    /^\/training\/activity\/\d+\?metric=power&range=6m$/
  );
  const analyzedSessions = analyze
    .getByTestId("analyze-sessions")
    .getByRole("link");
  expect(await analyzedSessions.count()).toBeGreaterThan(0);
  expect(
    await analyzedSessions.evaluateAll((links) =>
      links.every((link) =>
        /^\/training\/activity\/\d+\?metric=power&range=6m$/.test(
          link.getAttribute("href") ?? ""
        )
      )
    )
  ).toBe(true);

  await followLink(
    page,
    powerProfileRide,
    /\/training\/activity\/\d+\?metric=power&range=6m$/
  );
  await expect(page.getByTestId("training-activity-page")).toBeVisible();
  await expect(
    page
      .getByTestId("ride-comparison")
      .getByRole("button", { name: "Power", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page
      .getByTestId("ride-traces")
      .getByRole("button", { name: "Power", exact: true })
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByTestId("ride-comparison-link").first() // first-ok: every comparison link must retain the lens
  ).toHaveAttribute("href", /\?metric=power&range=6m$/);
  const adjacentActivityLinks = page.locator(
    '[data-testid="activity-older-link"], [data-testid="activity-newer-link"]'
  );
  expect(await adjacentActivityLinks.count()).toBeGreaterThan(0);
  expect(
    await adjacentActivityLinks.evaluateAll((links) =>
      links.every((link) =>
        /\?metric=power&range=6m$/.test(link.getAttribute("href") ?? "")
      )
    )
  ).toBe(true);
  const cyclingOverview = page.getByTestId("ride-cycling-overview-link");
  await expect(cyclingOverview).toHaveAttribute(
    "href",
    "/training?tab=analyze&kind=cardio&item=Cycling&metric=power&range=6m"
  );
  await followLink(
    page,
    cyclingOverview,
    /\/training\?tab=analyze&kind=cardio&item=Cycling&metric=power&range=6m$/
  );
  await expect(page.getByTestId("cycling-overview")).toBeVisible();
  // Selected state on the #2895 select is its VALUE, not a highlighted link.
  await expect(
    page
      .getByTestId("cycling-progression")
      .getByRole("combobox", { name: "Metric" })
  ).toHaveValue("power");

  await page.goto("/timeline?category=activity");
  await expect(
    page.getByRole("link", {
      name: "Strava morning ride",
      exact: true,
    })
  ).toHaveAttribute("href", /^\/training\/activity\/\d+$/);
});

test("cycling-family activities reuse rich analysis with indoor-aware surfaces", async ({
  page,
}) => {
  const db = new Database(workerDbPath());
  const insert = db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        avg_hr, elevation_m, avg_speed_kmh, relative_effort, avg_power_w,
        weighted_avg_power_w, avg_cadence, avg_temp_c, source, external_id)
     VALUES (1, ?, 'cardio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
  );
  const spinOne = Number(
    insert.run(
      "2026-07-10",
      "Fictional studio intervals",
      45,
      null,
      JSON.stringify([{ name: "Spinning", type: "cardio" }]),
      145,
      900,
      null,
      68,
      178,
      186,
      91,
      22,
      "e2e:spinning-1"
    ).lastInsertRowid
  );
  insert.run(
    "2026-07-17",
    "Fictional studio endurance",
    50,
    null,
    JSON.stringify([{ name: "Spinning", type: "cardio" }]),
    150,
    950,
    null,
    72,
    188,
    195,
    93,
    23,
    "e2e:spinning-2"
  );
  insert.run(
    "2026-07-12",
    "Fictional trail loops",
    75,
    18,
    JSON.stringify([{ name: "Mountain Biking", type: "cardio" }]),
    154,
    620,
    14.4,
    87,
    204,
    216,
    79,
    24,
    "e2e:mountain-bike-1"
  );
  db.prepare(
    `INSERT INTO activity_routes (activity_id, polyline, source)
     VALUES (?, '_p~iF~ps|U_ulLnnqC_mqNvxq\`@', 'synthetic')`
  ).run(spinOne);
  const spinStreams = JSON.stringify({
    time: { data: [0, 5, 10, 15, 20] },
    watts: { data: [150, 180, 210, 190, 170] },
    cadence: { data: [80, 85, 90, 88, 84] },
  });
  db.prepare(
    `INSERT INTO activity_telemetry
       (profile_id, activity_id, source, streams_json, snapshot_at,
        stream_summary_json)
     VALUES (1, ?, 'synthetic', ?, '2026-07-10T12:00:00Z', ?)`
  ).run(
    spinOne,
    spinStreams,
    // Written here rather than left to a boot: the server is already running, so
    // nothing would fill it before this spec asserts (#2292).
    serializeCyclingStreamSummary(summarizeCyclingStreams(spinStreams, null))
  );
  db.close();

  await page.goto("/training?tab=analyze&kind=cardio&item=Spinning&range=all");
  const analyze = page.getByTestId("analyze-section");
  await expect(page.getByTestId("cycling-overview")).toBeVisible();
  await expect(
    analyze.getByRole("heading", { name: "Session progression" })
  ).toBeVisible();
  await expect(
    analyze.getByRole("heading", { name: "Session history" })
  ).toBeVisible();
  await expect(
    analyze.getByRole("heading", { name: "When you train" })
  ).toBeVisible();
  await expect(analyze.getByText("Conditions", { exact: true })).toHaveCount(0);
  await expect(
    page.getByTestId("cycling-progression").getByRole("link", {
      name: "Elevation",
      exact: true,
    })
  ).toHaveCount(0);
  await expect(page.getByTestId("cycling-totals")).not.toContainText(
    "Elevation"
  );
  const coverage = page.getByTestId("cycling-data-coverage");
  await expect(coverage).toContainText("Sensor traces");
  await expect(coverage).not.toContainText("Mapped rides");
  await expect(coverage).not.toContainText("Segment data");

  const latestSession = analyze.getByRole("link", {
    name: "Latest session",
    exact: true,
  });
  await expect(latestSession).toHaveAttribute(
    "href",
    /\/training\/activity\/\d+\?metric=duration&range=all&item=Spinning$/
  );
  await followLink(
    page,
    latestSession,
    /\/training\/activity\/\d+\?metric=duration&range=all&item=Spinning$/
  );
  await expect(page.getByTestId("ride-cycling-overview-link")).toHaveText(
    "Spinning overview"
  );
  await expect(page.getByTestId("ride-summary")).not.toContainText(
    "Elevation gain"
  );
  await expect(page.getByTestId("ride-summary")).not.toContainText(
    "Temperature"
  );
  // The SECTION, not just the summary line (#3172 F3). `hasCourse` gates both a
  // nav entry and the section itself, and what survived here pinned only the
  // summary — so an indoor Spinning session rendering an empty route map and a
  // segments block would have shipped green.
  await expect(page.getByTestId("activity-section-course")).toHaveCount(0);
  // The nav ENTRY too (`hasCourse` gates both). Counted rather than read as
  // text, because an indoor session may not clear the three-section bar at all
  // and a not.toContainText against a missing nav fails for the wrong reason.
  await expect(
    page.locator(
      '[data-testid="activity-section-navigation"] a[href="#course"]'
    )
  ).toHaveCount(0);
  await expect(page.getByTestId("ride-comparison")).toContainText(
    "1 similar session"
  );

  await page.goto(
    "/training?tab=analyze&kind=cardio&item=Mountain%20Biking&range=all"
  );
  await expect(page.getByTestId("cycling-overview")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Ride progression" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "When you ride" })
  ).toBeVisible();
  await expect(page.getByText("Conditions", { exact: true })).toBeVisible();
});

test("a ride detail scopes wearable HR minutes to that ride's clock window", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  await openRideRecord(page, "Zone 2 base ride");

  const heartRate = page.getByTestId("session-heart-rate");
  const chart = page.getByTestId("session-heart-rate-chart");
  const zones = page.getByTestId("session-heart-rate-zones");
  await expect(page.getByTestId("activity-intensity")).toContainText(
    "Moderate"
  );
  await expect(heartRate).toContainText("60 recorded min");
  expect(
    await heartRate.evaluate(
      (element) => element.closest('[data-testid^="activity-section-"]')?.id
    )
  ).toBe("effort");
  await expect(
    heartRate.getByRole("button", {
      name: /Shows one-minute heart-rate readings from this ride/,
    })
  ).toBeVisible();
  await expect(chart).toBeVisible();
  await expect(chart.locator("svg")).toBeVisible();
  const zoneBands = chart.locator(".recharts-reference-area");
  await expect(zoneBands).toHaveCount(5);
  await expect(zoneBands.nth(0).locator('[fill="#0ea5e9"]')).toHaveCount(1);
  await expect(zoneBands.nth(1).locator('[fill="#16a34a"]')).toHaveCount(1);
  await expect(zoneBands.nth(2).locator('[fill="#eab308"]')).toHaveCount(1);
  await expect(zoneBands.nth(3).locator('[fill="#f97316"]')).toHaveCount(1);
  await expect(zoneBands.nth(4).locator('[fill="#ef4444"]')).toHaveCount(1);
  for (const zone of ["Z1", "Z2", "Z3", "Z4", "Z5"]) {
    await expect(chart.getByText(zone, { exact: true })).toBeVisible();
  }
  const bpmTicks = (await chart.locator("svg text").allTextContents()).filter(
    (label) => /^\d{3}$/.test(label) && Number(label) >= 100
  );
  expect(bpmTicks).toHaveLength(6);
  const tooltip = chart.locator(".recharts-tooltip-wrapper");
  await expect(tooltip).toHaveCSS("transition-property", "none");
  await expect(page.getByTestId("ride-zone-2")).toContainText("50 min · 83%");
  await expect(page.getByTestId("ride-zone-4")).toContainText("10 min · 17%");
  await expect(page.getByTestId("ride-zone-1")).toContainText("0 min · 0%");
});

// ── #3500: THE RIDE DETAIL'S SUMMARY, MEASURED ───────────────────────────────
//
// Four fixes on one surface, and each one's guard is a RENDERED reading rather
// than the class string that produced it. #3466 is why: a stepped 16px seam
// shipped rendering at 24px with a computed-style guard reading 16 on the very
// element. Class assertions appear here only where the fix IS a class choice —
// the tone — and even there the colours are compared as painted pixels.
test("the ride summary states each fact once and uses the whole phone (#3500)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");
  await openRideRecord(page, "Strava morning ride");

  // WAIT FOR THE CONTENT BEFORE MEASURING ANYTHING. Every assertion below is
  // about size, position or count on a card the router streams in; an empty
  // region fits any width and satisfies any "nothing clips" claim it is handed.
  const deltas = page.locator('[data-testid^="ride-summary-comparison-"]');
  await expect(deltas.first()).toBeVisible(); // first-ok: waiting for the group to exist, not for a particular member
  const measurements = page.getByTestId("ride-recorded-measurements");
  await expect(measurements).toBeVisible();
  await expect(page.getByTestId("ride-stat-power")).toBeVisible();

  // ── ITEM 1: no comparison delta wears a link-adjacent tone ─────────────────
  //
  // The floor first: this ride carries a speed delta plus five neutral ones, so
  // a run that found two would be pronouncing a colour rule over a card that had
  // not finished arriving.
  const NEUTRAL_DELTA_FLOOR = 5;
  const toneRows = await deltas.evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-testid") ?? "",
      className: el.className,
      color: getComputedStyle(el).color,
    }))
  );
  expect(
    toneRows.length,
    "fewer comparison deltas than this ride renders — the card had not arrived"
  ).toBeGreaterThanOrEqual(NEUTRAL_DELTA_FLOOR + 1);
  expect(
    toneRows.filter((r) => /text-sky-/.test(r.className)).map((r) => r.id),
    "a comparison delta is still toned sky. Sky at font-medium is the app's most " +
      "link-like non-link (#3487 item 2), and these are static text."
  ).toEqual([]);

  // The painted proof, in BOTH themes: every non-speed delta is the same colour
  // as a plain `text-slate-600 dark:text-slate-300` run on this page, and speed's
  // directional tone is a different colour from it. The reference span is forged
  // rather than borrowed from a neighbour so the reading cannot drift with an
  // unrelated component's styling, and it is planted and read inside ONE
  // synchronous evaluate so no re-render can land between the two.
  const tonesIn = async (): Promise<{
    reference: string;
    neutral: string[];
    speed: string;
  }> =>
    page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "text-slate-600 dark:text-slate-300";
      probe.textContent = "reference";
      document.body.appendChild(probe);
      const reference = getComputedStyle(probe).color;
      probe.remove();
      const all = [
        ...document.querySelectorAll(
          '[data-testid^="ride-summary-comparison-"]'
        ),
      ];
      return {
        reference,
        neutral: all
          .filter(
            (el) =>
              el.getAttribute("data-testid") !== "ride-summary-comparison-speed"
          )
          .map((el) => getComputedStyle(el).color),
        speed: getComputedStyle(
          document.querySelector(
            '[data-testid="ride-summary-comparison-speed"]'
          )!
        ).color,
      };
    });

  const light = await tonesIn();
  expect(light.neutral.length).toBeGreaterThanOrEqual(NEUTRAL_DELTA_FLOOR);
  expect(
    [...new Set(light.neutral)],
    "the neutral deltas are not all painting the one no-verdict tone"
  ).toEqual([light.reference]);
  expect(
    light.speed,
    "speed lost its direction tone — only speed has a clear better/worse " +
      "direction among these deltas, and that reasoning is unchanged"
  ).not.toBe(light.reference);

  await page.evaluate(() => document.documentElement.classList.add("dark"));
  const dark = await tonesIn();
  expect([...new Set(dark.neutral)]).toEqual([dark.reference]);
  expect(dark.speed).not.toBe(dark.reference);
  expect(
    dark.reference,
    "the dark theme did not actually engage, so the reading above is the light " +
      "one twice"
  ).not.toBe(light.reference);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));

  // ── ITEM 2: a comparison line wraps; it never clips ────────────────────────
  //
  // Nothing on the seeded ride clips today, and an assertion that the shipped
  // sentences fit would pass for as long as they happen to be short. So the
  // claim is made about a sentence long enough to force the question: the
  // weighted-power delta's text is replaced with one two and a half times its
  // length, and the box has to grow DOWN rather than cut it off. Restored
  // immediately; the page is discarded either way.
  const wrapping = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(
      '[data-testid="ride-summary-comparison-weighted-power"]'
    )!;
    const before = el.textContent ?? "";
    const short = el.getBoundingClientRect().height;
    el.textContent =
      "Weighted: 1234 W above 1234 W median across every comparable ride in this window";
    const rect = el.getBoundingClientRect();
    const long = {
      height: rect.height,
      right: rect.left + window.scrollX + rect.width,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflowX: getComputedStyle(el).overflowX,
      whiteSpace: getComputedStyle(el).whiteSpace,
      textOverflow: getComputedStyle(el).textOverflow,
    };
    el.textContent = before;
    return { short, ...long, viewport: document.documentElement.clientWidth };
  });
  expect(
    wrapping.height,
    "a longer comparison sentence did not make its line box taller, so it is not " +
      "wrapping — it is being cut off somewhere"
  ).toBeGreaterThan(wrapping.short);
  expect(wrapping.scrollWidth).toBeLessThanOrEqual(wrapping.clientWidth + 1);
  expect(wrapping.right).toBeLessThanOrEqual(wrapping.viewport);
  expect(wrapping.whiteSpace).not.toBe("nowrap");
  expect(wrapping.textOverflow).not.toBe("ellipsis");

  // ── ITEM 4: two columns at 390, and the Power box keeps the full row ───────
  const boxes = await measurements.evaluate((dl) =>
    [...dl.children].map((child) => {
      const r = child.getBoundingClientRect();
      return {
        id: child.getAttribute("data-testid") ?? "",
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
      };
    })
  );
  expect(boxes.length).toBeGreaterThanOrEqual(6);
  const power = boxes.find((b) => b.id === "ride-stat-power")!;
  const columns = boxes.filter((b) => b.id !== "ride-stat-power");
  // Two columns: the narrow boxes take two distinct x positions, and at least one
  // pair shares a row. A single-column grid gives one x and no shared row, which
  // is what this block did below `sm` before #3500 item 4.
  expect(new Set(columns.map((b) => b.x)).size).toBe(2);
  expect(
    columns.some((a) => columns.some((b) => b.x !== a.x && b.y === a.y)),
    "no two secondary stats share a row at 390px — the block is still one column " +
      "with an empty right half"
  ).toBe(true);
  // Power spans both, so its three sub-lines keep the room item 2 needs.
  expect(power.width).toBeGreaterThan(Math.max(...columns.map((b) => b.width)));
  const contentWidth = (await measurements.boundingBox())!.width;
  expect(Math.abs(power.width - contentWidth)).toBeLessThanOrEqual(1);

  // ── AND DESKTOP IS UNCHANGED ──────────────────────────────────────────────
  //
  // Two columns above `sm` was already the count, and Power took one of them.
  // The phone span is `col-span-2 sm:col-span-1` for exactly this reason: an
  // unscoped `col-span-2` measured 726px here instead of 347px and reflowed the
  // four boxes below it. A page pass that quietly rearranges the desktop layout
  // is not the fix this issue asked for.
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.getByTestId("ride-stat-power")).toBeVisible();
  const desktop = await measurements.evaluate((dl) =>
    [...dl.children].map((child) => {
      const r = child.getBoundingClientRect();
      return {
        id: child.getAttribute("data-testid") ?? "",
        x: Math.round(r.x),
        width: Math.round(r.width),
      };
    })
  );
  const desktopPower = desktop.find((b) => b.id === "ride-stat-power")!;
  const desktopOthers = desktop.filter((b) => b.id !== "ride-stat-power");
  expect(new Set(desktop.map((b) => b.x)).size).toBe(2);
  expect(
    desktopPower.width,
    "Power is spanning both columns on the desktop layout too — the phone-only " +
      "span lost its `sm:` scope"
  ).toBe(desktopOthers[0].width);
});

// The other side of item 3's boundary. Every ride the seed carries seeds an
// average heart rate, so without this the "renders only when the headline is not
// already saying it" rule would only ever be exercised in its hiding direction —
// and a rule tested in one direction is a deletion wearing a condition.
test("a ride with a max heart rate but no average still shows the Max heart rate box (#3500)", async ({
  page,
}) => {
  const db = new Database(workerDbPath());
  db.prepare(
    `INSERT INTO activities
       (profile_id, date, type, title, duration_min, distance_km, components,
        avg_hr, max_hr, avg_speed_kmh, source, external_id)
     VALUES (1, ?, 'cardio', ?, ?, ?, ?, NULL, ?, ?, 'manual', ?)`
  ).run(
    "2026-07-24",
    "Fictional max-only ride",
    40,
    18,
    JSON.stringify([{ name: "Cycling", type: "cardio" }]),
    166,
    22,
    "e2e:max-hr-only"
  );
  db.close();

  await page.goto("/training?tab=log");
  await openRideRecord(page, "Fictional max-only ride");

  const summary = page.getByTestId("ride-summary-line");
  await expect(summary).toBeVisible();
  // The composite cannot state a max without an average, so it says nothing about
  // heart rate at all — and the secondary box is then the only place the reader
  // can learn the number.
  await expect(summary).not.toContainText("bpm");
  await expect(page.getByTestId("ride-stat-max-heart-rate")).toContainText(
    "166 bpm"
  );
});

test("canonical activity navigation stays compact on a ride", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training?tab=log");

  await openRideRecord(page, "Strava morning ride");

  const navigation = page.getByTestId("activity-ledger-navigation");
  const previous = page.getByTestId("activity-older-link");
  const next = page.getByTestId("activity-newer-link");
  await expect(navigation).toBeVisible();
  await expect(previous).toBeVisible();
  await expect(next).toBeVisible();
  const navigationBox = await navigation.boundingBox();
  const previousBox = await previous.boundingBox();
  const nextBox = await next.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(previousBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  expect(navigationBox!.width).toBeGreaterThan(300);
  expect(navigationBox!.x + navigationBox!.width).toBeLessThanOrEqual(390);
  expect(Math.abs(previousBox!.y - nextBox!.y)).toBeLessThanOrEqual(1);
  expect(previousBox!.x).toBeGreaterThan(navigationBox!.x);
  expect(
    Math.abs(
      nextBox!.x + nextBox!.width - (navigationBox!.x + navigationBox!.width)
    )
  ).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("activity-ledger-navigation")).toHaveCount(1);
  await expect(page.getByTestId("ride-history")).toHaveCount(0);
  const comparisonChart = page.getByTestId("ride-comparison-chart");
  expect(
    await comparisonChart.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
  expect(
    await page
      .getByTestId("ride-recorded-measurements")
      .evaluate((element) => getComputedStyle(element).borderTopWidth)
  ).toBe("0px");
});

// ActivityDetailSectionNav had NO coverage anywhere in the repo (#3172 F2): the
// unification changed the section set from Overview/... to Effort/Course/Muscles/
// Details, and the assertions were deleted rather than updated. Two things were
// left free to regress silently — the href/id agreement every in-page anchor
// depends on, and the "at least three sections" gate.
test("the activity section nav links resolve to the sections they name", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  await openRideRecord(page, "Strava morning ride");

  const nav = page.getByTestId("activity-section-navigation");
  await expect(nav).toBeVisible();
  const links = nav.getByRole("link");
  // The gate: the nav renders only past three optional sections, so a ride that
  // shows it must have at least that many.
  const count = await links.count();
  expect(count).toBeGreaterThanOrEqual(3);

  const targets: string[] = [];
  for (let index = 0; index < count; index++) {
    const href = await links.nth(index).getAttribute("href");
    expect(href).toMatch(/^#[a-z]+$/);
    targets.push(href!.slice(1));
  }
  // An outdoor ride is the case that HAS a course, which is the positive half of
  // the indoor assertion above.
  expect(targets).toContain("course");

  for (const id of targets) {
    // THE ASSERTION: every anchor lands on a real section. Renaming a section id
    // without the nav breaks every in-page link on the page, and nothing else in
    // the repo would notice.
    await expect(page.locator(`section#${id}`)).toHaveCount(1);
    await expect(page.getByTestId(`activity-section-${id}`)).toHaveCount(1);
  }
});
