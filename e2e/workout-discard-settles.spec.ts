import { test, expect } from "./fixtures";
import { deleteActivityFromForm } from "./helpers";

// THE WITNESS FOR THE SETTLED DISCARD (issue #3267).
//
// #3267 is a defect no other spec in this suite can fail on. It is a race between a
// test ending and a Server Action landing, so on a quiet box every workout spec is
// green with the bug in place, and on a loaded CI shard an arbitrary one of them is
// red — with all of its OWN assertions passing, because the thing that notices is the
// shared-profile guard reading the worker database in teardown. Two authors paid a
// triage cycle on PRs (#3255, #3269) whose diffs could not reach a workout.
//
// So the repair (`deleteActivityFromForm`, e2e/helpers.ts) needed a falsifier that
// does not depend on the box being busy. This is it: hold every Server Action
// response for two seconds and drive one live workout through start and discard. That
// is enough to separate the two events the old spelling confused —
//
//   • the CLIENT one: the editor closes and the dock unmounts from `setState`, which
//     is what every call site used to assert and what still happens immediately;
//   • the SERVER one: `deleteActivity` runs and the row is gone.
//
// WHAT FAILS THIS TEST is `noStrandedSharedDraft` (e2e/fixtures.ts), deliberately.
// This spec acts as the SHARED admin, so the standing guard is live over it, and the
// guard reads the database after the page and its context are gone — an aborted
// in-flight delete has therefore not happened. Take the toast settle out of
// `deleteActivityFromForm` and this goes red 5/5 with the same message the CI
// sightings carried; put it back and it is green 5/5. Measured both ways.
//
// That is also why the discard is the last thing here and there is no assertion after
// it. An `expect(workout-dock).toHaveCount(0)` would NOT discriminate: it retries for
// five seconds, which is long enough for the held delete to land behind it, so it
// passes against the bug. The guard is the assertion, and it is the only one that
// tests the actual claim — that the spec left the shared profile as it found it.
const ACTION_DELAY_MS = 2000;

test("a discarded live workout is gone from the database before the test ends (#3267)", async ({
  page,
}) => {
  test.slow();
  // The same interception shape stale-build-save.spec.ts uses to fail actions: the
  // `next-action` header is what distinguishes a Server Action POST from any other
  // request, and nothing else on the page is touched.
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "POST" && request.headers()["next-action"]) {
      await new Promise((resolve) => setTimeout(resolve, ACTION_DELAY_MS));
    }
    await route.continue();
  });

  // Create-at-start (#2870 step 3): the row exists from the tap, so there is a live
  // draft on the shared profile from here until something deletes it.
  await page.goto("/training?tab=log");
  await page.getByRole("main").getByTestId("start-workout").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  await deleteActivityFromForm(page);
});
