import { test, expect } from "@playwright/test";

// #11: Journal (activity) cards show provenance — where the row came from — plus
// when it was added. The seed carries a Strava-imported ride alongside the
// hand-logged workouts, so the two provenance states are both on the page: the
// integration row identifies Strava plus its edit state, a manual row reads
// "Manual", and
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
  await expect(stravaCard.getByTestId("activity-provenance")).toContainText(
    "edited"
  );
  await expect(stravaCard.getByTestId("edit-lock-badge")).toHaveCount(0);
  await expect(stravaCard.getByTestId("edit-lock-icon")).toHaveAttribute(
    "title",
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
  await stravaCard.getByRole("button", { name: "Activity actions" }).click();
  await expect(page.getByTestId("edit-lock-resume")).toHaveText(
    "Resume sync updates"
  );
  await page.keyboard.press("Escape");

  // A hand-logged session reads "Manual" — provenance distinguishes the two.
  const manualCard = page
    .locator(".card", { hasText: "Basketball pickup" })
    .first();
  await expect(manualCard).toBeVisible();
  await expect(manualCard.getByTestId("activity-provenance-source")).toHaveText(
    "Manual"
  );
  await expect(manualCard.getByTestId("activity-provenance")).not.toContainText(
    "edited"
  );
  await manualCard
    .getByRole("button", { name: "Basketball pickup", exact: true })
    .click();
  const moreDetails = page.getByRole("button", { name: /^More details/ });
  if ((await moreDetails.getAttribute("aria-expanded")) === "false")
    await moreDetails.click();
  // The live estimate is visible but must not be copied into form state merely
  // by opening an existing manual row.
  await expect(page.getByTestId("est-calories-input")).toHaveValue(
    /^[1-9]\d*$/
  );
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(manualCard.getByTestId("activity-provenance")).not.toContainText(
    "edited"
  );

  // The seeded 5K mirrors a complete Health Connect exercise-session row,
  // including its clock window and provider provenance.
  const healthConnectCard = page.locator(".card", { hasText: "5k run" });
  await expect(healthConnectCard).toBeVisible();
  await expect(
    healthConnectCard.getByTestId("activity-provenance-source")
  ).toHaveText("Google Health Connect");
  const healthSummary = healthConnectCard.getByTestId("activity-summary");
  await expect(healthSummary).toContainText("06:45–07:09");
  await expect(healthSummary).toContainText("24 min");
  await expect(healthSummary).toContainText("5 km");
  await expect(healthSummary).toContainText("12.5 km/h");
  await expect(healthSummary).toContainText("372 kcal");
  await expect(healthSummary).not.toContainText("≈ 372 kcal");
  await healthConnectCard
    .getByRole("button", { name: "5k run", exact: true })
    .click();
  const healthDetails = page.getByTestId("imported-activity-details");
  await expect(healthDetails).toContainText("Recorded measurements");
  await expect(
    healthDetails.getByRole("heading", { name: "Recorded measurements" })
  ).toHaveCSS("text-transform", "uppercase");
  await expect(healthDetails).toContainText("Active energy372 kcal");
  await expect(page.getByTestId("imported-edit-note")).toHaveCount(0);
  // Opening an imported row must not run the manual calorie auto-fill, dirty
  // the form, and trigger the 700 ms autosave/edit lock by itself.
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(
    healthConnectCard.getByTestId("activity-provenance")
  ).not.toContainText("edited");
  await expect(healthConnectCard.getByTestId("edit-lock-icon")).toHaveCount(0);
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
  await expect(summary).toContainText("07:15–08:17");
  await expect(summary).toContainText("62 min");
  await expect(summary).toContainText("148/171 bpm");
  await expect(summary).toContainText("24.5 km");
  await expect(summary).toContainText("648 kcal");
  await expect(summary).not.toContainText("≈ 648 kcal");
  await expect(summary).toHaveClass(/text-slate-600/);
  await expect(summary).toHaveClass(/dark:text-slate-300/);

  const hardActivity = page
    .locator('[id^="activity-"]')
    .filter({ hasText: "Intervals" })
    .first();
  const intensity = hardActivity.getByTestId("activity-intensity");
  await expect(intensity).toContainText("Hard");
  await expect(intensity.getByTestId("activity-intensity-dot")).toHaveClass(
    /bg-rose-500/
  );

  // Rich measurements are structured list values, not a collection of badges.
  const metrics = ride.getByTestId("activity-metrics");
  await expect(metrics.locator("li")).toHaveCount(7);
  await expect(metrics).not.toContainText("148/171 bpm");
  await expect(metrics).toContainText("210 m");
  await expect(metrics).toContainText("186 W (193 NP)");
  await expect(metrics).toContainText("88 rpm");
  await expect(metrics).toContainText("692 kJ");
  await expect(metrics).toContainText("18°C");
  await expect(metrics).toContainText("Effort 72");
  await expect(metrics.locator(".badge")).toHaveCount(0);
  await expect(metrics).toHaveClass(/text-slate-400/);
  await expect(metrics).toHaveClass(/dark:text-slate-500/);

  // Cardio descriptions follow their names inline, matching strength rows,
  // rather than being pushed to the far edge of the card.
  const cardioRow = ride.getByTestId("journal-cardio-row");
  await expect(cardioRow).not.toHaveClass(/justify-between/);
  await expect(cardioRow).toHaveClass(/gap-x-2/);

  // Provenance remains present but uses the card's quiet footer treatment.
  const source = ride.getByTestId("activity-provenance-source");
  await expect(source).toHaveText("Strava");
  await expect(source).not.toHaveClass(/badge/);
  await expect(ride.getByTestId("activity-provenance")).toHaveClass(
    /text-slate-400/
  );
  await expect(source).not.toHaveClass(/text-slate-500|text-slate-600/);

  // Long notes disclose in place without opening the activity editor.
  const notes = ride.getByTestId("activity-notes");
  await expect(notes).toHaveClass(/text-slate-600/);
  await expect(notes).toHaveClass(/dark:text-slate-300/);
  const parts = ride.getByTestId("activity-parts");
  const notesHandle = await notes.elementHandle();
  expect(notesHandle).not.toBeNull();
  expect(
    await parts.evaluate(
      (content, note) =>
        Boolean(
          content.compareDocumentPosition(note) &
          Node.DOCUMENT_POSITION_FOLLOWING
        ),
      notesHandle!
    )
  ).toBe(true);
  await expect(notes).toHaveClass(/line-clamp-2/);
  const more = ride.getByRole("button", { name: "More" });
  await more.click();
  await expect(ride.getByRole("button", { name: "Less" })).toHaveAttribute(
    "aria-expanded",
    "true"
  );
  await expect(notes).not.toHaveClass(/line-clamp-2/);

  // Desktop places the compact route beside the complete supporting-detail block,
  // so the activity row uses the space beneath short metric text instead of leaving
  // a map-height empty pocket.
  const desktopMetrics = await metrics.boundingBox();
  const desktopRoute = await ride.getByTestId("route-map").boundingBox();
  const desktopParts = await ride.getByTestId("activity-parts").boundingBox();
  expect(desktopMetrics).not.toBeNull();
  expect(desktopRoute).not.toBeNull();
  expect(desktopParts).not.toBeNull();
  expect(desktopRoute!.x).toBeGreaterThan(desktopMetrics!.x);
  expect(desktopParts!.y).toBeLessThan(desktopRoute!.y + desktopRoute!.height);

  // On a phone the same shared route surface follows all details as a shallow,
  // full-width strip.
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetrics = await metrics.boundingBox();
  const mobileRoute = await ride.getByTestId("route-map").boundingBox();
  const mobileParts = await ride.getByTestId("activity-parts").boundingBox();
  expect(mobileMetrics).not.toBeNull();
  expect(mobileRoute).not.toBeNull();
  expect(mobileParts).not.toBeNull();
  expect(mobileRoute!.y).toBeGreaterThan(mobileParts!.y + mobileParts!.height);
  expect(mobileRoute!.width).toBeGreaterThan(mobileRoute!.height * 2);
});

test("strength target status is named and muscle filters are quiet text", async ({
  page,
}) => {
  await page.goto("/training");

  const push = page.locator(".card", { hasText: "Push day" }).first();
  await expect(push).toBeVisible();
  await expect(push.getByTestId("activity-summary")).toContainText("kcal");
  await expect(push.getByTestId("activity-metrics")).toHaveCount(0);
  await expect(
    push.getByRole("img", { name: "All sets hit their target reps" })
  ).toBeVisible();
  await push.getByRole("button", { name: "Push day", exact: true }).click();
  await expect(
    page.getByTestId("activity-target-status").filter({ hasText: "Target met" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  const muscleFilter = push
    .getByRole("button", { name: "Chest", exact: true })
    .first();
  await expect(muscleFilter).toBeVisible();
  await expect(muscleFilter).not.toHaveClass(/badge/);

  // Exercise name, set summary, and context form one compact row rather than a
  // forced two-line name/metadata block with the summary pushed to the far edge.
  const benchRow = push
    .getByTestId("journal-strength-row")
    .filter({ hasText: "Barbell Bench Press" })
    .first();
  const exerciseName = benchRow.getByRole("button", {
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

test("the activity editor shows all stored Strava measurements as read-only", async ({
  page,
}) => {
  await page.goto("/training");

  const stravaCard = page.locator(".card", {
    hasText: "Strava morning ride",
  });
  await stravaCard
    .getByRole("button", { name: "Strava morning ride", exact: true })
    .click();

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
  await expect(editorHeader.getByTestId("edit-lock-icon")).toHaveAttribute(
    "title",
    "You edited this activity, so Strava won’t update it."
  );
  await expect(details).toContainText("Recorded measurements");
  await expect(details).not.toContainText("Recorded by Strava");
  await expect(page.getByTestId("more-details-summary")).toContainText(
    "648 kcal · 148 bpm · 210 m"
  );
  await expect(page.getByTestId("more-details-summary")).not.toContainText(
    "Strava"
  );
  await expect(
    page.getByRole("heading", { name: "Route", exact: true })
  ).toHaveClass(/label/);
  await expect(page.getByTestId("more-details-chevron")).toHaveClass(
    /rotate-90/
  );

  const primary = details.getByTestId("strava-primary-stats");
  await expect(primary.locator(":scope > div")).toHaveCount(4);
  await expect(primary).toContainText("Heart rate148 bpm171 max");
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
  const formRoute = await page
    .getByTestId("activity-form-route")
    .getByTestId("route-map")
    .boundingBox();
  expect(formRoute).not.toBeNull();
  expect(formRoute!.height).toBeLessThanOrEqual(110);

  expect(
    await primary.evaluate(
      (node) => getComputedStyle(node).gridTemplateColumns.split(" ").length
    )
  ).toBe(4);
  await page.setViewportSize({ width: 390, height: 844 });
  // Switching presentation modes closes the docked editor; reopen the same
  // activity in the mobile overlay, then measure the shared content component.
  await stravaCard
    .getByRole("button", { name: "Strava morning ride", exact: true })
    .click();
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
