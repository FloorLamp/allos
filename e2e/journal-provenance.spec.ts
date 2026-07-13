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
