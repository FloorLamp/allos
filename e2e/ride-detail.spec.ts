import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import {
  serializeCyclingStreamSummary,
  summarizeCyclingStreams,
} from "@/lib/cycling-stream-summary";

test("a Journal ride opens a read-first detail with the stored ride measurements", async ({
  page,
}) => {
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  const detailLink = stravaCard.getByTestId("ride-detail-link");
  await expect(detailLink).toHaveAttribute("href", /\/training\/rides\/\d+/);
  await followLink(page, detailLink, /\/training\/rides\/\d+$/);

  const rideDetail = page.getByTestId("ride-detail");
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
  const sectionNavigation = page.getByTestId("ride-section-navigation");
  await expect(sectionNavigation).toBeVisible();
  for (const section of ["Overview", "Effort", "Course", "Details"]) {
    await expect(
      sectionNavigation.getByRole("link", { name: section, exact: true })
    ).toHaveAttribute("href", `#${section.toLowerCase()}`);
  }
  expect(
    await page
      .getByTestId("ride-summary")
      .evaluate(
        (element) => element.closest('[data-testid^="ride-section-"]')?.id
      )
  ).toBe("overview");
  await expect(page.getByTestId("ride-recorded-measurements")).toBeVisible();
  await expect(
    page
      .getByTestId("ride-summary")
      .getByRole("heading", { name: "Recorded measurements" })
  ).toHaveCount(0);
  await expect(page.getByTestId("ride-stat-active-time")).toHaveClass(
    /bg-slate-50/
  );
  await expect(
    page.getByRole("heading", { name: "Strava morning ride", exact: true })
  ).toBeVisible();
  await expect(page.getByTestId("ride-stat-active-time")).toContainText(
    "62 min"
  );
  await expect(page.getByTestId("ride-stat-distance")).toContainText("24.5 km");
  await expect(page.getByTestId("ride-stat-heart-rate")).toContainText(
    "148 bpm"
  );
  await expect(page.getByTestId("ride-stat-heart-rate")).toContainText(
    "171 max"
  );
  await expect(page.getByTestId("ride-stat-heart-rate")).toContainText("Zone");
  const heartRateValue = page
    .getByTestId("ride-stat-heart-rate")
    .locator("dd[style]");
  await expect(heartRateValue).toHaveAttribute("style", /color:/);
  await expect(heartRateValue).toHaveAttribute("title", /Zone \d/);
  await expect(page.getByTestId("ride-stat-power")).toContainText("186 W");
  await expect(page.getByTestId("ride-stat-power")).toContainText(
    "193 weighted"
  );
  await expect(page.getByTestId("ride-stat-power")).toContainText("612 max");
  await expect(page.getByTestId("ride-stat-power")).toContainText("W/kg");
  await expect(page.getByTestId("ride-stat-speed")).toContainText("41.8 max");
  await expect(page.getByTestId("ride-stat-elevation")).toContainText("210 m");
  await expect(page.getByTestId("ride-stat-workout-type")).toContainText(
    "Workout"
  );
  await expect(page.getByTestId("ride-stat-relative-effort")).toContainText(
    "72"
  );
  await expect(page.getByTestId("ride-stat-cadence")).toContainText("88 rpm");
  await expect(page.getByTestId("ride-stat-kilojoules")).toContainText(
    "692 kJ"
  );
  await expect(page.getByTestId("ride-stat-temperature")).toContainText("18°C");
  await expect(page.getByTestId("ride-stat-active-kcal")).toContainText(
    "648 kcal"
  );
  await expect(page.getByTestId("ride-stat-bike")).toContainText("Road Bike");
  const highlights = page.getByTestId("ride-highlights");
  await expect(highlights).toBeVisible();
  await expect(page.getByTestId("ride-highlight-comparison")).toHaveCount(0);
  await expect(
    page.getByTestId("ride-highlight-heart-rate-zone")
  ).toContainText("Most time in HR zone");
  await expect(
    page.getByTestId("ride-highlight-heart-rate-zone")
  ).toContainText("Zone 2");
  await expect(page.getByTestId("ride-stat-heart-rate")).toContainText(
    "Average falls in Zone"
  );
  await expect(
    page.getByTestId("ride-highlight-segment-results")
  ).toContainText("1 personal best");
  await expect(page.getByTestId("ride-highlight-efficiency")).toContainText(
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
        /^\/training\/rides\/\d+$/.test(link.getAttribute("href") ?? "")
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
  await expect(page.getByTestId("ride-summary-comparison-power")).toHaveClass(
    /text-sky-700/
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
  const previousRideLink = page.getByTestId("ride-previous-link");
  const nextRideLink = page.getByTestId("ride-next-link");
  await expect(previousRideLink).toHaveAttribute(
    "href",
    /\/training\/rides\/\d+$/
  );
  await expect(nextRideLink).toHaveAttribute("href", /\/training\/rides\/\d+$/);
  await expect(previousRideLink).toHaveAttribute(
    "aria-label",
    /^Previous ride: .+\. \w+, \w+ \d{1,2}, 2026 · \d+ min · .+ km$/
  );
  await expect(nextRideLink).toHaveAttribute(
    "aria-label",
    /^Next ride: .+\. \w+, \w+ \d{1,2}, 2026 · \d+ min · .+ km$/
  );
  await expect(previousRideLink).toContainText("Previous ride");
  await expect(previousRideLink).toContainText("min");
  await expect(previousRideLink).toContainText("km");
  await expect(nextRideLink).toContainText("Next ride");
  await expect(nextRideLink).toContainText("min");
  await expect(nextRideLink).toContainText("km");
  const route = page.getByTestId("ride-route");
  await expect(route.getByRole("heading", { name: "Route" })).toHaveClass(
    /text-base/
  );
  expect(
    await route.evaluate(
      (element) => element.closest('[data-testid^="ride-section-"]')?.id
    )
  ).toBe("course");
  await expect(route.getByTestId("route-map")).toBeVisible();
  await expect(page.getByTestId("ride-route-history")).toContainText(
    "earlier ride"
  );
  const traces = page.getByTestId("ride-traces");
  expect(
    await traces.evaluate(
      (element) => element.closest('[data-testid^="ride-section-"]')?.id
    )
  ).toBe("effort");
  await expect(traces.getByRole("button", { name: "Power" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  const telemetryChart = page.getByTestId("ride-telemetry-chart");
  const telemetrySvg = telemetryChart.locator("svg");
  await expect(telemetrySvg).toBeVisible();
  await expect(page.getByTestId("ride-heart-rate-chart")).toBeVisible();
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
      .getByTestId("ride-heart-rate-chart")
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
  await expect(page.getByTestId("ride-laps")).toContainText("Lap 2");
  await expect(page.getByTestId("ride-segments")).toContainText(
    "Fictional park climb"
  );
  await expect(page.getByTestId("ride-segments")).toContainText("PR #1");
  expect(
    await page
      .getByTestId("ride-segments")
      .evaluate(
        (element) => element.closest('[data-testid^="ride-section-"]')?.id
      )
  ).toBe("course");
  await expect(page.getByTestId("ride-notes")).toContainText(
    "steady endurance work"
  );
  expect(
    await page
      .getByTestId("activity-provenance")
      .evaluate(
        (element) => element.closest('[data-testid^="ride-section-"]')?.id
      )
  ).toBe("details");
  await expect(page.getByTestId("activity-provenance")).toContainText("Strava");
  await expect(page.getByTestId("activity-provenance")).toContainText("edited");

  await page.getByRole("button", { name: "Edit ride" }).click();
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
  expect(
    await cyclingShell.getByTestId("combobox-option").count()
  ).toBeGreaterThan(1);
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
    await expect(
      progression.getByRole("link", { name: metric, exact: true })
    ).toBeVisible();
  }
  await expect(
    cyclingShell.getByRole("link", { name: "Distance", exact: true })
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

  await followLink(
    page,
    analyze.getByRole("link", { name: "Power", exact: true }),
    /metric=power/
  );
  await expect(analyze).toContainText("Avg power across logged rides");
  await followLink(
    page,
    progression.getByRole("link", { name: "6m", exact: true }),
    /range=6m/
  );
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
    /^\/training\/rides\/\d+\?metric=power&range=6m$/
  );
  const powerProfileRide = page
    .getByTestId("cycling-power-profile")
    .getByRole("link")
    .first(); // first-ok: seeded power records are a deterministic duration-ordered set
  await expect(powerProfileRide).toHaveAttribute(
    "href",
    /^\/training\/rides\/\d+\?metric=power&range=6m$/
  );
  const analyzedSessions = analyze
    .getByTestId("analyze-sessions")
    .getByRole("link");
  expect(await analyzedSessions.count()).toBeGreaterThan(0);
  expect(
    await analyzedSessions.evaluateAll((links) =>
      links.every((link) =>
        /^\/training\/rides\/\d+\?metric=power&range=6m$/.test(
          link.getAttribute("href") ?? ""
        )
      )
    )
  ).toBe(true);

  await followLink(
    page,
    powerProfileRide,
    /\/training\/rides\/\d+\?metric=power&range=6m$/
  );
  await expect(page.getByTestId("ride-detail")).toBeVisible();
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
  const adjacentRideLinks = page
    .getByTestId("ride-header-navigation")
    .getByRole("link");
  expect(await adjacentRideLinks.count()).toBeGreaterThan(0);
  expect(
    await adjacentRideLinks.evaluateAll((links) =>
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
  await expect(
    page
      .getByTestId("cycling-progression")
      .getByRole("link", { name: "Power", exact: true })
  ).toHaveClass(/bg-brand-600/);

  await page.goto("/timeline?category=activity");
  await expect(
    page.getByRole("link", {
      name: "Strava morning ride",
      exact: true,
    })
  ).toHaveAttribute("href", /^\/training\/rides\/\d+$/);
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
    /\/training\/rides\/\d+\?metric=duration&range=all&item=Spinning$/
  );
  await followLink(
    page,
    latestSession,
    /\/training\/rides\/\d+\?metric=duration&range=all&item=Spinning$/
  );
  await expect(page.getByTestId("ride-cycling-overview-link")).toHaveText(
    "Spinning overview"
  );
  await expect(page.getByTestId("ride-section-navigation")).not.toContainText(
    "Course"
  );
  await expect(page.getByTestId("ride-summary")).not.toContainText(
    "Elevation gain"
  );
  await expect(page.getByTestId("ride-summary")).not.toContainText(
    "Temperature"
  );
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
  await page.goto("/training");

  const zoneRide = page.locator(".card", {
    hasText: "Zone 2 base ride",
  });
  await followLink(
    page,
    zoneRide.getByTestId("ride-detail-link"),
    /\/training\/rides\/\d+$/
  );

  const heartRate = page.getByTestId("ride-heart-rate");
  const chart = page.getByTestId("ride-heart-rate-chart");
  const zones = page.getByTestId("ride-heart-rate-zones");
  await expect(page.getByTestId("ride-stat-intensity")).toContainText(
    "Moderate"
  );
  await expect(heartRate).toContainText("60 recorded min");
  expect(
    await heartRate.evaluate(
      (element) => element.closest('[data-testid^="ride-section-"]')?.id
    )
  ).toBe("effort");
  await expect(heartRate).toContainText(
    "One-minute readings recorded during this ride"
  );
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

test("adjacent ride navigation stays compact in the mobile header", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  await followLink(
    page,
    stravaCard.getByTestId("ride-detail-link"),
    /\/training\/rides\/\d+$/
  );

  const navigation = page.getByTestId("ride-header-navigation");
  const previous = page.getByTestId("ride-previous-link");
  const next = page.getByTestId("ride-next-link");
  await expect(navigation).toBeVisible();
  await expect(previous).toBeVisible();
  await expect(next).toBeVisible();
  await expect(next).toHaveAttribute("title", /^Next ride:/);
  await expect(previous).toHaveAttribute("title", /^Previous ride:/);
  const navigationBox = await navigation.boundingBox();
  const previousBox = await previous.boundingBox();
  const nextBox = await next.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(previousBox).not.toBeNull();
  expect(nextBox).not.toBeNull();
  expect(navigationBox!.width).toBeGreaterThan(300);
  expect(navigationBox!.x + navigationBox!.width).toBeLessThanOrEqual(390);
  expect(Math.abs(previousBox!.y - nextBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(previousBox!.x - navigationBox!.x)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      nextBox!.x + nextBox!.width - (navigationBox!.x + navigationBox!.width)
    )
  ).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("ride-previous-meta")).toHaveCSS(
    "flex-wrap",
    "wrap"
  );
  await expect(page.getByTestId("ride-next-meta")).toHaveCSS(
    "flex-wrap",
    "wrap"
  );
  await expect(page.getByTestId("ride-history")).toHaveCount(0);
  const comparisonChart = page.getByTestId("ride-comparison-chart");
  expect(
    await comparisonChart.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
  const sectionNavigation = page.getByTestId("ride-section-navigation");
  expect(
    await sectionNavigation.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1
    )
  ).toBe(true);
  expect(
    await page
      .getByTestId("ride-recorded-measurements")
      .evaluate(
        (element) => getComputedStyle(element.parentElement!).borderTopWidth
      )
  ).toBe("0px");
});
