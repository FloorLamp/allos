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
