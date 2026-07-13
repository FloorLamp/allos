import { test, expect } from "@playwright/test";

// #11: Journal (activity) cards show provenance — where the row came from — plus
// when it was added. The seed carries a Strava-imported ride alongside the
// hand-logged workouts, so the two provenance states are both on the page: the
// integration row's chip reads "Strava", a manual row's reads "Manual", and
// every card surfaces an "added <relative time>" stamp.
test("journal cards show a source provenance chip and 'added' timestamp (#11)", async ({
  page,
}) => {
  // /training defaults to the Log tab, which renders the journal feed.
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  await expect(stravaCard).toBeVisible();
  await expect(stravaCard.getByTestId("activity-provenance-source")).toHaveText(
    "Strava"
  );
  await expect(stravaCard.getByTestId("activity-provenance")).toContainText(
    "added"
  );

  // A hand-logged session reads "Manual" — provenance distinguishes the two.
  const manualCard = page
    .locator(".card", { hasText: "Basketball pickup" })
    .first();
  await expect(manualCard).toBeVisible();
  await expect(manualCard.getByTestId("activity-provenance-source")).toHaveText(
    "Manual"
  );
});

// #569: the seeded Strava ride carries a captured GPS route, so its journal card
// renders a tile-free SVG route thumbnail (decoded from the encoded polyline, no
// basemap, no external request). Manual rows carry no route → no thumbnail.
test("an imported ride with a route shows a tile-free SVG route thumbnail (#569)", async ({
  page,
}) => {
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  await expect(stravaCard).toBeVisible();
  const routeMap = stravaCard.getByTestId("route-map");
  await expect(routeMap).toBeVisible();
  // It's an inline <svg> tracing a <path> — not an <img> (nothing is fetched).
  await expect(routeMap).toHaveJSProperty("tagName", "svg");
  await expect(routeMap.locator("path")).toHaveCount(1);

  // A hand-logged session has no route → no thumbnail.
  const manualCard = page
    .locator(".card", { hasText: "Basketball pickup" })
    .first();
  await expect(manualCard).toBeVisible();
  await expect(manualCard.getByTestId("route-map")).toHaveCount(0);
});

test("journal cards prioritize a summary and progressively disclose details", async ({
  page,
}) => {
  await page.goto("/training");

  const ride = page.locator(".card", { hasText: "Strava morning ride" });
  await expect(ride).toBeVisible();

  // Primary measurements and intensity read as one quiet, scan-friendly line.
  const summary = ride.getByTestId("activity-summary");
  await expect(summary).toContainText("62 min");
  await expect(summary).toContainText("24.5 km");
  await expect(summary).toContainText("Moderate");

  // Rich measurements are structured list values, not a collection of badges.
  const metrics = ride.getByTestId("activity-metrics");
  await expect(metrics.locator("li")).toHaveCount(3);
  await expect(metrics).toContainText("148/171 bpm");
  await expect(metrics.locator(".badge")).toHaveCount(0);

  // Provenance remains present but uses the card's quiet footer treatment.
  const source = ride.getByTestId("activity-provenance-source");
  await expect(source).toHaveText("Strava");
  await expect(source).not.toHaveClass(/badge/);

  // Long notes disclose in place without opening the activity editor.
  const notes = ride.getByTestId("activity-notes");
  await expect(notes).toHaveClass(/line-clamp-2/);
  const more = ride.getByRole("button", { name: "More" });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(notes).not.toHaveClass(/line-clamp-2/);

  // Desktop places the compact route beside the metric block.
  const desktopMetrics = await metrics.boundingBox();
  const desktopRoute = await ride.getByTestId("route-map").boundingBox();
  expect(desktopMetrics).not.toBeNull();
  expect(desktopRoute).not.toBeNull();
  expect(desktopRoute!.x).toBeGreaterThan(desktopMetrics!.x);

  // On a phone the same shared route surface becomes a shallow full-width strip.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetrics = await metrics.boundingBox();
  const mobileRoute = await ride.getByTestId("route-map").boundingBox();
  expect(mobileMetrics).not.toBeNull();
  expect(mobileRoute).not.toBeNull();
  expect(mobileRoute!.y).toBeGreaterThan(mobileMetrics!.y);
  expect(mobileRoute!.width).toBeGreaterThan(mobileRoute!.height * 2);
});

test("strength target status is named and muscle filters are quiet text", async ({
  page,
}) => {
  await page.goto("/training");

  const push = page.locator(".card", { hasText: "Push day" }).first();
  await expect(push).toBeVisible();
  await expect(
    push.getByRole("img", { name: "All sets hit their target reps" })
  ).toBeVisible();

  const muscleFilter = push
    .getByRole("button", { name: "Chest", exact: true })
    .first();
  await expect(muscleFilter).toBeVisible();
  await expect(muscleFilter).not.toHaveClass(/badge/);
});

// The imported Strava ride is stored with the athlete's free-text title ("Strava
// morning ride") but a canonical "Cycling" component. The journal must icon it
// off the structured sport (a bike), matching the activity form — not fall back
// to the generic cardio (run) icon from the title alone.
test("an imported cycling ride shows the bike icon in the journal", async ({
  page,
}) => {
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  await expect(stravaCard).toBeVisible();
  await expect(stravaCard.getByTestId("activity-icon")).toHaveAttribute(
    "data-icon",
    "bike"
  );
});

// #451: the Log feed is paged SERVER-SIDE — only the newest window of days renders on
// load, and "Load more" fetches an older window on demand (instead of shipping the
// whole history to the client up front). The seed carries ~16 weeks of Push/Pull/Legs
// sessions, so there are well over one page of day sections: clicking "Load more"
// reveals additional, older day groups.
test("the Log feed pages older days in via 'Load more' (#451)", async ({
  page,
}) => {
  await page.goto("/training");

  const days = page.locator('section[id^="day-"]');
  await expect(days.first()).toBeVisible();
  const before = await days.count();

  const loadMore = page.getByTestId("journal-load-more");
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  // After loading an older window, strictly more day sections are on the page.
  await expect
    .poll(async () => days.count(), { timeout: 10_000 })
    .toBeGreaterThan(before);
});
