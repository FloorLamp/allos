import { test, expect } from "./fixtures";
import {
  comboboxRows,
  deleteActivityFromForm,
  hydratedClick,
  settledFill,
} from "./helpers";
import { LIVE_CREATE_RACE_EVENT } from "@/lib/live-session-race-event";
import { listLiveDrafts, SHARED_PROFILE_ID } from "./shared-profile-guard";
import { workerDbPath } from "./worker-env";

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

// The lift the seed trains repeatedly, so the editor has a coached suggestion to
// tap "Use" on — that tap is what makes the first set land inside the held window.
const EXERCISE = "Barbell Bench Press";

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

// THE WITNESS FOR THE RACING START (issue #3441).
//
// A SECOND witness in this file rather than a second file, because it is the same
// defect class one step earlier: a Server Action in flight and a test that does not
// wait for it. #3267 was the DISCARD not landing before teardown; this is the START
// not landing before the next tap.
//
// WHAT IT DRIVES, AND WHY IT MUST DRIVE IT UNSETTLED. Starting a live workout POSTs
// the create-at-start row (#2870 step 3). Pick an exercise before that POST answers
// and the form has no id to save against, so its own auto-save INSERTS a row — and
// the session now has two. The provider then adopts the created row and stands the
// tab on ITS page, while the row holding the user's sets is pointed at by nothing.
// On a slow connection that is two activities in the log for one workout.
//
// So the start here is a BARE click on purpose. `settledClick` is the right repair
// for a spec whose subject is something else (#3440 made exactly that repair, in
// `bottom-edge-stacking.mobile.spec.ts`, and it was correct) — but a spec whose
// subject IS the race has to hold the link open deliberately, or it tests nothing.
// Do not "fix" this call. That is what the two-second hold below is for.
//
// WHY THE ASSERTION IS A DATABASE COUNT AND NOT A DOM CHECK, which is the whole
// lesson of this bug: with the defect in place the panel is up, the delete works,
// the toast says "Activity deleted." and the dock behaves — all green, all TRUE,
// all about the ONE row the editor happens to hold. The failure is in the row
// nobody is looking at, and nothing on screen addresses it. `listLiveDrafts` asks
// the four columns `computeWorkoutPresence` asks (e2e/shared-profile-guard.ts), so
// this counts the same thing the app calls an active workout.
//
// MEASURED both ways, one reading rather than a sample (the #3384 shape):
//   • un-settled start, before the fix — 2 drafts, 4 of 4 runs, 4 red
//   • settled start, before the fix     — 1 draft,  4 of 4 runs
//   • un-settled start, after the fix   — 1 draft,  4 of 4 runs, 4 green
// CPU throttling does NOT reproduce it: throttling slows the CLICKS too, closing
// the very window the race needs. A race that a general slowdown HIDES rather than
// widens needs its specific link held, not the whole page slowed.
test("a live workout started on a slow connection is ONE activity, not two (#3441)", async ({
  page,
}) => {
  test.slow();
  // Hold the FIRST Server Action POST after arming — which is the start, because
  // nothing else posts between the arm and the click below — and let everything
  // after it through at full speed. Holding EVERY action (the test above) would
  // slow the auto-save too and close the window, exactly as CPU throttling does.
  //
  // HELD UNTIL THIS TEST SAYS SO, not for a fixed span, and that is the difference
  // between driving the race and sampling it. A wall-clock hold puts the whole
  // guard at the mercy of how fast the box drives the three clicks below: measured
  // on this tree with the defect present, inserting 700ms of client latency kept it
  // red 2/2, and 1200ms turned it GREEN 4/4 with the bug still in the tree. That
  // failure direction is the dangerous one — a slower shard makes this PASS — and it
  // is how #3440 came to leave nothing watching this path in the first place.
  let armed = false;
  let held = 0;
  let releaseStart: (() => void) | null = null;
  const startHeld = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      armed &&
      held === 0 &&
      request.method() === "POST" &&
      request.headers()["next-action"]
    ) {
      held++;
      await startHeld;
    }
    await route.continue();
  });

  await page.goto("/training?tab=log");

  // The form's OWN save, awaited by its CONTENT rather than by a fading indicator
  // or by its position in the stream. Armed BEFORE the click that starts
  // everything, because the alternative — arming once the row is owned — is itself
  // a race against the 700ms debounce, and a guard for a race may not contain one.
  // The exercise name is the discriminator: the start POST carries only the type
  // and an empty title, and the editor's other action traffic is argument-encoded
  // rather than a form body.
  const setSaved = page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "POST") return false;
    if (!request.headers()["next-action"]) return false;
    return (request.postData() ?? "").includes(EXERCISE);
  });

  // THE FUSE. The editor announces it when a rowless save comes due while the
  // create-at-start is still in flight — the race, said out loud by the app rather
  // than assumed by the test. It is announced OUTSIDE the fix's decision, so this
  // still fires on a tree with the fix removed and the count below stays the thing
  // that catches the defect. If the box is slow enough that the create lands first,
  // no line arrives and this times out: a wrong-SETUP failure, loudly, instead of a
  // vacuous green.
  const raced = page.waitForEvent("console", (message) =>
    message.text().includes(LIVE_CREATE_RACE_EVENT)
  );

  armed = true;
  await page.getByRole("main").getByTestId("start-workout").click(); // unsettled-ok: the race is the subject — see the note above
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Log a set INSIDE the window the start POST is still open. The Delete control
  // appearing is the form reporting it owns a row — the moment the second one used
  // to exist.
  await settledFill(page, page.getByPlaceholder(/What did you do/), EXERCISE);
  await hydratedClick(
    page,
    comboboxRows(page).filter({ hasText: EXERCISE }).first() // first-ok: transient combobox list this test just opened by typing EXERCISE
  );
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();

  // The save has come due against a session with no id. NOW let the start land —
  // so the window is bounded by the app's own progress and not by a constant, and
  // there is no number in this file that a loaded shard can invalidate.
  await raced;
  releaseStart!();

  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // ONE row for one session. A PRESENCE-flavoured count, not an absence: a second
  // row that was created is created, and no amount of extra waiting makes it go
  // away — so this is a single reading, not a retrying poll that a slow write could
  // sneak past (#3287).
  expect(listLiveDrafts(workerDbPath(), SHARED_PROFILE_ID)).toHaveLength(1);

  // …and the one row is the one the tab is standing on, so the dock and the editor
  // are talking about the same activity. Without this the count above would still
  // pass if the fallback row won and the created one were discarded — a defensible
  // outcome, but not the one this app promises (#2870 step 3: the session's page
  // appears when the row does, and there is only ever one URL).
  const [draft] = listLiveDrafts(workerDbPath(), SHARED_PROFILE_ID);
  await page.waitForURL(`**/training/activity/${draft.id}`);

  // AND THE SET LANDED ON THAT ROW — the half that could regress into SILENT DATA
  // LOSS, because the fix DEFERS the form's rowless save until the create answers.
  // Break the re-arm that releases it and this session is one row standing empty
  // with the user's set never written, which every count above would call correct.
  // The title is the discriminator: `openLive` mints the row with an EMPTY title,
  // and only a save from the editor writes the derived one.
  await setSaved;
  const after = listLiveDrafts(workerDbPath(), SHARED_PROFILE_ID);
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(draft.id);
  expect(after[0].title).not.toBe("");

  // Discard through the editor, and the dock goes with it — the user-visible half
  // of the bug, which stayed put because the draft the dock watched was not the one
  // that got deleted. The standing #3173 guard then confirms nothing was left.
  await deleteActivityFromForm(page);
  await expect(page.getByTestId("workout-dock")).toHaveCount(0);
});

// THE REFUSAL LEG (#451 / #3441), which is the promise the fix above could most
// easily break in silence.
//
// The gate that stops a rowless save from minting a second row has to be RELEASED
// when the create-at-start cannot answer — a refusal, a dead connection, a gym with
// no signal. Release it only on success and the form waits forever: the session
// never gets a row at all, which is strictly worse than the two-row defect this
// branch fixes, and no spec in the tree would notice. `entry-ergonomics` aborts
// every action POST but opens through "Add activity" (not live, so the gate is
// never armed), and `stale-build-save` starts live but arms its failure AFTER the
// create has landed. Neither can reach this.
//
// So: refuse the start, then log a set and require the session to exist anyway —
// on the form's OWN row, the pre-#2870-step-3 shape that a dead spot degrades to.
test("a live workout whose start is refused still logs, on one row (#451)", async ({
  page,
}) => {
  test.slow();
  // Answer the start — and only the start — the way a proxy answers mid-swap, the
  // shape autosave-retry.spec.ts already uses. Every later action is untouched, so
  // the form's own save is a real one.
  let armed = false;
  let refused = 0;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      armed &&
      refused === 0 &&
      request.method() === "POST" &&
      request.headers()["next-action"]
    ) {
      refused++;
      return route.fulfill({
        status: 502,
        contentType: "text/plain",
        body: "Bad Gateway",
      });
    }
    await route.continue();
  });

  await page.goto("/training?tab=log");
  armed = true;
  await page.getByRole("main").getByTestId("start-workout").click(); // unsettled-ok: there is nothing to settle on — this start is refused
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  await settledFill(page, page.getByPlaceholder(/What did you do/), EXERCISE);
  await hydratedClick(
    page,
    comboboxRows(page).filter({ hasText: EXERCISE }).first() // first-ok: transient combobox list this test just opened by typing EXERCISE
  );
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();

  // Delete appearing is the form reporting it owns a row — here it can only be one
  // it minted itself, because the create it would otherwise have adopted was
  // refused. This is the assertion that hangs if the gate is never released.
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  const drafts = listLiveDrafts(workerDbPath(), SHARED_PROFILE_ID);
  expect(drafts).toHaveLength(1);
  expect(drafts[0].title).not.toBe("");

  await deleteActivityFromForm(page);
});
