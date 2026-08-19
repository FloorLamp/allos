import { test, expect } from "./fixtures";
import { type Locator, type Page } from "@playwright/test";
import { followLink, hydratedClick } from "./helpers";

// The Log feed is a slim index into canonical activity records. Return to that
// index before each selection, then scope record assertions to the activity page.
function activityPage(page: Page) {
  return page.getByTestId("training-activity-page");
}
async function openActivityPage(page: Page, row: Locator, title: string) {
  await page.goto("/training?tab=log");
  await followLink(
    page,
    row.getByRole("link", { name: title, exact: true }),
    /\/training\/activity\/\d+$/
  );
  const card = activityPage(page).filter({ hasText: title });
  await expect(card).toBeVisible();
  return card;
}

// Tailwind 4 emits palette colors through CSS Color 4 variables, whose computed
// serialization is lab() rather than the rgb() string Tailwind 3 produced.
// Compare against the utility's own rendered color so this still catches a
// cascade regression without pinning a browser-specific serialization.
async function expectUtilityColor(locator: Locator, utility: string) {
  const colors = await locator.evaluate((element, className) => {
    const reference = document.createElement("span");
    reference.className = className;
    document.body.append(reference);
    const actual = getComputedStyle(element).color;
    const expected = getComputedStyle(reference).color;
    reference.remove();
    return { actual, expected };
  }, utility);
  expect(colors.actual).toBe(colors.expected);
}

// #11: Training Log (activity) cards show provenance — where the row came from — plus
// when it was added. The seed carries a Strava-imported ride alongside the
// hand-logged workouts, so the two provenance states are both on the page: the
// integration row identifies Strava plus its edit state, a manual row reads
// "Manual", and
// every card surfaces an "added <relative time>" stamp.
test("training log cards show a source provenance chip and 'added' timestamp (#11)", async ({
  page,
}) => {
  // /training defaults to the Log tab, which renders the training log feed —
  // slim rows; provenance lives on the canonical activity page.
  await page.goto("/training?tab=log");

  const stravaRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  const stravaCard = await openActivityPage(
    page,
    stravaRow,
    "Strava morning ride"
  );
  await expect(stravaCard.getByTestId("activity-provenance-source")).toHaveText(
    "Strava"
  );
  await expect(stravaCard.getByTestId("activity-provenance")).toContainText(
    "added"
  );
  await expect(stravaCard.getByTestId("activity-provenance")).toContainText(
    "edited"
  );
  await expect(stravaCard.getByTestId("edit-lock-badge")).toHaveCount(0);
  await expect(stravaCard.getByTestId("edit-lock-icon")).toHaveAttribute(
    "aria-label",
    "You edited this activity, so Strava won’t update it."
  );
  await expect(
    stravaCard.getByTestId("edit-lock-icon").locator("svg")
  ).toHaveClass(/icon-info-circle/);
  expect(
    await stravaCard
      .getByTestId("edit-lock-notice")
      .evaluate((node) => node.nextElementSibling)
  ).toBeNull();
  // Keep the card footer compact: the re-enable action lives in the portaled
  // activity menu, not beside the lock marker.
  await expect(stravaCard.getByTestId("edit-lock-resume")).toHaveCount(0);
  await hydratedClick(
    page,
    stravaCard.getByRole("button", { name: "Activity actions" })
  );
  await expect(page.getByTestId("edit-lock-resume")).toHaveText(
    "Resume sync updates"
  );
  await page.keyboard.press("Escape");

  // A hand-logged session reads "Manual" — provenance distinguishes the two.
  const manualRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Basketball pickup" })
    .first(); // first-ok: the manual "Basketball pickup" activity THIS spec created (unique name)
  const manualCard = await openActivityPage(
    page,
    manualRow,
    "Basketball pickup"
  );
  await expect(manualCard.getByTestId("activity-provenance-source")).toHaveText(
    "Manual"
  );
  await expect(manualCard.getByTestId("activity-provenance")).not.toContainText(
    "edited"
  );
  // The canonical page's Edit action opens the shared editor.
  await activityPage(page).getByTestId("activity-page-edit").click();
  const moreDetails = page.getByRole("button", { name: /^More details/ });
  if ((await moreDetails.getAttribute("aria-expanded")) === "false")
    await moreDetails.click();
  // The live estimate is visible but must not be copied into form state merely
  // by opening an existing manual row.
  await expect(page.getByTestId("est-calories-input")).toHaveValue(
    /^[1-9]\d*$/
  );
  await page.waitForTimeout(900); // waitfortimeout-ok: bounded absence-of-effect: wait past the 700ms autosave debounce, then assert the manual row stayed un-edited — opening it must not trip autosave; non-occurrence has no positive event to await
  await page.getByRole("button", { name: "Done" }).click();
  await expect(manualCard.getByTestId("activity-provenance")).not.toContainText(
    "edited"
  );

  // The seeded 5K mirrors a complete Health Connect exercise-session row,
  // including its clock window and provider provenance.
  const healthRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "5k run" });
  const healthConnectCard = await openActivityPage(page, healthRow, "5k run");
  await expect(
    healthConnectCard.getByTestId("activity-provenance-source")
  ).toHaveText("Google Health Connect");
  await expect(
    healthConnectCard.getByTestId("activity-page-time")
  ).toContainText("06:45–07:09");
  const healthSummary = healthConnectCard.getByTestId("activity-summary");
  await expect(healthSummary).toContainText("24 min");
  await expect(healthSummary).toContainText("5 km");
  await expect(healthSummary).toContainText("12.5 km/h");
  await expect(healthSummary).toContainText("372 kcal");
  await expect(healthSummary).not.toContainText("≈ 372 kcal");
  await activityPage(page).getByTestId("activity-page-edit").click();
  const healthDetails = page.getByTestId("imported-activity-details");
  await expect(healthDetails).toContainText("Recorded measurements");
  await expect(
    healthDetails.getByRole("heading", { name: "Recorded measurements" })
  ).toHaveCSS("text-transform", "uppercase");
  await expect(healthDetails).toContainText("Active energy372 kcal");
  await expect(page.getByTestId("imported-edit-note")).toHaveCount(0);
  // Opening an imported row must not run the manual calorie auto-fill, dirty
  // the form, and trigger the 700 ms autosave/edit lock by itself.
  await page.waitForTimeout(900); // waitfortimeout-ok: bounded absence-of-effect: wait past the 700ms autosave debounce, then assert the imported row stayed un-edited — opening it must not run the calorie auto-fill; non-occurrence has no positive event to await
  await page.getByRole("button", { name: "Done" }).click();
  await expect(
    healthConnectCard.getByTestId("activity-provenance")
  ).not.toContainText("edited");
  await expect(healthConnectCard.getByTestId("edit-lock-icon")).toHaveCount(0);
});

// #569: the seeded Strava ride carries a captured GPS route, so its record card
// renders a tile-free SVG route thumbnail on its canonical page
// (decoded from the encoded polyline, no basemap, no external request). Manual
// rows carry no route → no thumbnail.
test("an imported ride with a route shows a tile-free SVG route thumbnail (#569)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const stravaRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  const stravaCard = await openActivityPage(
    page,
    stravaRow,
    "Strava morning ride"
  );
  const routeMap = stravaCard.getByTestId("route-map");
  await expect(routeMap).toBeVisible();
  await expect(stravaCard.getByTestId("ride-route")).toContainText("Route");
  // It's an inline <svg> tracing a <path> — not an <img> (nothing is fetched).
  await expect(routeMap).toHaveJSProperty("tagName", "svg");
  await expect(routeMap.locator("path")).toHaveCount(1);

  // A hand-logged session has no route → no thumbnail (swap the pane to it).
  const manualRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Basketball pickup" })
    .first(); // first-ok: the manual "Basketball pickup" activity THIS spec created (unique name)
  const manualCard = await openActivityPage(
    page,
    manualRow,
    "Basketball pickup"
  );
  await expect(manualCard.getByTestId("route-map")).toHaveCount(0);
});

test("training log cards prioritize a summary and progressively disclose details", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  // The canonical page carries the full summary; the feed row stays compact.
  const rideRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  const ride = await openActivityPage(page, rideRow, "Strava morning ride");

  // Primary measurements and intensity read as one quiet, scan-friendly line.
  await expect(ride.getByTestId("activity-page-time")).toContainText(
    "07:15–08:17"
  );
  const summary = ride.getByTestId("ride-summary-line");
  await expect(summary).toContainText("62 min");
  await expect(summary).toContainText("148/171 bpm");
  const heartRate = ride.getByTestId("activity-heart-rate");
  await expect(heartRate).toHaveAttribute("title", "Zone 3 · Tempo");
  await expectUtilityColor(heartRate, "text-slate-800");
  await expect(heartRate.getByTestId("activity-heart-rate-icon")).toHaveCSS(
    "color",
    "rgb(234, 179, 8)"
  );
  await expect(summary).toContainText("24.5 km");
  await expect(summary).toContainText("648 kcal");
  await expect(summary).not.toContainText("≈ 648 kcal");

  // Intensity renders on the full record: swap the pane to the hard session.
  const hardRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Intervals" })
    .first(); // first-ok: the "Intervals" activity THIS spec created (filtered by its name)
  const hardActivity = await openActivityPage(page, hardRow, "Intervals");
  const intensity = hardActivity.getByTestId("activity-intensity");
  await expect(intensity).toContainText("Hard");
  await expect(intensity.getByTestId("activity-intensity-dot")).toHaveClass(
    /bg-rose-500/
  );

  // Swap the pane back to the ride for its structured measurements.
  await openActivityPage(page, rideRow, "Strava morning ride");

  // Quiet session metadata uses the same shared line as ordinary activities;
  // cycling measurements remain grouped in the ride details below it.
  const metrics = ride.getByTestId("activity-metrics");
  await expect(metrics.getByTestId("activity-gear")).toHaveText("Road Bike");
  await expect(metrics.locator(".badge")).toHaveCount(0);
  await expect(metrics).toHaveClass(/text-slate-500/);
  await expect(metrics).toHaveClass(/dark:text-slate-400/);
  await expect(ride.getByTestId("ride-recorded-measurements")).toBeVisible();

  // Provenance remains present but uses the card's quiet footer treatment.
  const source = ride.getByTestId("activity-provenance-source");
  await expect(source).toHaveText("Strava");
  await expect(source).not.toHaveClass(/badge/);
  await expect(ride.getByTestId("activity-provenance")).toHaveClass(
    /text-slate-500/
  );
  await expect(source).not.toHaveClass(/text-slate-600/);

  // Notes and route are discoverable sections on the canonical page.
  const notes = ride.getByTestId("activity-notes");
  await expect(ride.getByTestId("activity-notes-card")).toContainText("Notes");
  await expect(notes).toBeVisible();
  await expect(
    ride.getByTestId("ride-route").getByTestId("route-map")
  ).toBeVisible();
});

test("strength target status is named and muscle filters are quiet text", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const pushRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Push day" })
    .first(); // first-ok: the newest seeded Push day session — order-agnostic
  const push = await openActivityPage(page, pushRow, "Push day");
  await expect(push.getByTestId("activity-summary")).toContainText("kcal");
  await expect(push.getByTestId("activity-metrics")).toHaveCount(0);
  await expect(
    push.getByRole("img", { name: "All sets hit their target reps" })
  ).toBeVisible();
  // Edit flows through the canonical activity page.
  await activityPage(page).getByTestId("activity-page-edit").click();
  await expect(
    page.getByTestId("activity-target-status").filter({ hasText: "Target met" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Muscle labels are quiet text everywhere the record renders — filterable
  // (the pane injects the tag handler like the old feed card did) but never
  // badge-styled.
  const muscleFilter = push.getByText("Chest", { exact: true }).first(); // first-ok: the Chest muscle label within the scoped Push day card (Bench and Incline both tag Chest)
  await expect(muscleFilter).toBeVisible();
  await expect(muscleFilter).not.toHaveClass(/badge/);

  // Exercise name, set summary, and context form one compact row rather than a
  // forced two-line name/metadata block with the summary pushed to the far edge.
  const benchRow = push
    .getByTestId("training-log-strength-row")
    .filter({ hasText: "Barbell Bench Press" })
    .first(); // first-ok: filtered to the Barbell Bench Press strength row — one match
  const exerciseName = benchRow.getByRole("link", {
    name: "Barbell Bench Press",
    exact: true,
  });
  const setSummary = benchRow.getByTestId("exercise-set-summary");
  const nameBox = await exerciseName.boundingBox();
  const summaryBox = await setSummary.boundingBox();
  const muscleBox = await muscleFilter.boundingBox();
  expect(nameBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  expect(muscleBox).not.toBeNull();
  expect(Math.abs(summaryBox!.y - nameBox!.y)).toBeLessThanOrEqual(3);
  expect(summaryBox!.x - (nameBox!.x + nameBox!.width)).toBeLessThanOrEqual(12);
  expect(Math.abs(muscleBox!.y - nameBox!.y)).toBeLessThanOrEqual(4);
});

// The imported Strava ride is stored with the athlete's free-text title ("Strava
// morning ride") but a canonical "Cycling" component. The training log's slim
// row must icon it off the structured sport (a bike), matching the activity
// form — not fall back to the generic cardio (run) icon from the title alone.
test("an imported cycling ride shows the bike icon in the training log", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const stravaRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  await expect(stravaRow).toBeVisible();
  await expect(stravaRow.getByTestId("activity-icon")).toHaveAttribute(
    "data-icon",
    "bike"
  );
});

test("the activity editor shows all stored Strava measurements as read-only", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  // Row → pane → Edit: the docked editor opens in the log's aside (#2897).
  const stravaRow = page
    .getByTestId("training-log-row")
    .filter({ hasText: "Strava morning ride" });
  await openActivityPage(page, stravaRow, "Strava morning ride");
  await activityPage(page).getByTestId("activity-page-edit").click();

  const details = page.getByTestId("imported-activity-details");
  await expect(details).toBeVisible();
  expect(
    await details.evaluate((node) => {
      const style = getComputedStyle(node);
      return [
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
        style.paddingLeft,
      ];
    })
  ).toEqual(["0px", "0px", "0px", "0px"]);
  // A locked row doesn't repeat a warning line in the form: the quiet, neutral
  // lock icon beside "edited" carries the short consequence tooltip.
  await expect(page.getByTestId("imported-edit-note")).toHaveCount(0);
  const editorHeader = page.getByTestId("activity-form-header");
  await expect(editorHeader.getByTestId("edit-lock-badge")).toHaveCount(0);
  const editLockIcon = editorHeader.getByTestId("edit-lock-icon");
  await expect(editLockIcon).toHaveAttribute(
    "aria-label",
    "You edited this activity, so Strava won’t update it."
  );
  // Keep keyboard focus in the form while the pointer opens the tooltip. Escape
  // still belongs to the visible child layer even though its trigger is not the
  // key event target.
  await page.getByTestId("set1-weight").first().focus(); // first-ok: any editor field keeps focus outside the hovered tooltip trigger
  await editLockIcon.hover();
  await expect(page.getByRole("tooltip")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  // Escape belongs to the open tooltip layer; it must not dismiss its editor.
  await expect(editorHeader).toBeVisible();
  await expect(details).toContainText("Recorded measurements");
  await expect(details).not.toContainText("Recorded by Strava");
  await expect(page.getByTestId("more-details-summary")).toContainText(
    "648 kcal · 148 bpm · 210 m"
  );
  await expect(page.getByTestId("more-details-summary")).not.toContainText(
    "Strava"
  );
  await expect(
    page
      .getByTestId("activity-form-route")
      .getByRole("heading", { name: "Route", exact: true })
  ).toHaveClass(/label/);
  await expect(page.getByTestId("more-details-chevron")).toHaveClass(
    /rotate-90/
  );

  const primary = details.getByTestId("strava-primary-stats");
  await expect(primary.locator(":scope > div")).toHaveCount(4);
  await expect(primary).toContainText("Heart rate148 bpm171 max");
  const heartRate = primary.getByTestId("imported-heart-rate");
  // This one is an inline domain color, not a Tailwind palette utility.
  await expect(heartRate).toHaveCSS("color", "rgb(234, 179, 8)");
  await expect(heartRate).toHaveAttribute("title", "Zone 3 · Tempo");
  await expect(primary).toContainText("Power186 W193 weighted · 612 max");
  await expect(primary).toContainText("Speed23.7 km/h41.8 max");
  await expect(primary).toContainText("Elevation gain210 m");
  await expect(primary.getByText("193 weighted")).toHaveAttribute(
    "title",
    "Weighted power accounts for changes in effort and better reflects the ride’s physiological load."
  );

  const secondary = details.getByTestId("strava-secondary-stats");
  await expect(secondary.locator(":scope > div")).toHaveCount(6);
  await expect(secondary).toContainText("Workout typeWorkout");
  await expect(secondary).toContainText("Relative effort72");
  await expect(secondary).toContainText("Cadence88 rpm");
  await expect(secondary).toContainText("Mechanical work692 kJ");
  await expect(secondary).toContainText("Active energy648 kcal");
  await expect(secondary).toContainText("Temperature18°C");
  await expect(page.getByTestId("activity-form-route")).toBeVisible();
  await expect(
    page.getByTestId("activity-form-route").getByTestId("route-map")
  ).toBeVisible();

  expect(
    await primary.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length
    )
  ).toBe(4);
  await page.setViewportSize({ width: 390, height: 844 });
  // The same open workspace becomes full-screen on a phone without losing form
  // state or changing to another presentation.
  const mobilePrimary = page.getByTestId("strava-primary-stats");
  await expect(mobilePrimary).toBeVisible();
  expect(
    await mobilePrimary.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length
    )
  ).toBe(2);
});

// #451: the Log feed is paged SERVER-SIDE — only the newest window of days renders on
// load, and "Load more" fetches an older window on demand (instead of shipping the
// whole history to the client up front). The seed carries ~16 weeks of Push/Pull/Legs
// sessions, so there are well over one page of day sections: clicking "Load more"
// reveals additional, older day groups.
test("the Log feed pages older days in via 'Load more' (#451)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const days = page.locator('section[id^="day-"]');
  await expect(days.first()).toBeVisible(); // first-ok: asserts a day section renders — order-agnostic presence
  const before = await days.count();

  const loadMore = page.getByTestId("training-log-load-more");
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  // After loading an older window, strictly more day sections are on the page.
  await expect
    .poll(async () => days.count(), { timeout: 10_000 })
    .toBeGreaterThan(before);
});
