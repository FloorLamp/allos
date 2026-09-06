import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { openCommandPalette } from "./nav";
import {
  appContent,
  comboboxRows,
  deleteActivityFromForm,
  hydratedClick,
  settledClick,
  settledFill,
} from "./helpers";

// Issue #340: live workout mode — the in-gym presentation of the SAME activity
// editor (no second engine), driven end-to-end against the seeded DB.
//
//   1. "Start workout" (training log aside + command palette) opens the live
//      layout: a control strip with the rest timer + Finish. Since #2870 step 3
//      it also CREATES the session row up front and navigates to its canonical
//      page — the overlay opens above that URL.
//   2. The rest timer is a client-side countdown — a lift-appropriate default,
//      preset chips, and a start/pause toggle.
//   3. Checking off a set (adding the next set) auto-starts the rest timer.
//   4. "Finish workout" stamps end=now, and the recap's Save closes the workspace.

// Create-at-start means every started session gets a row up front. Leaving a
// live workspace only minimizes it; specs explicitly delete their own draft.

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the entry-ergonomics spec documents).
async function pickActivity(page: Page, name: string) {
  const field = page.getByPlaceholder(/What did you do/);
  await settledFill(page, field, name);
  const option = comboboxRows(page).filter({ hasText: name }).first(); // eslint-disable-line no-restricted-properties -- first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
  await hydratedClick(page, option);
  await expect(field).toHaveValue(name);
}

// Starting is one interaction with two completion boundaries: the imperative
// Server Action creates the row, then the router applies its canonical page beneath
// the already-open overlay. Wait for both before touching controlled form state.
async function startLiveWorkout(page: Page) {
  await settledClick(page, page.getByRole("main").getByTestId("start-workout"));
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.waitForURL(/\/training\/activity\/\d+$/);
  await expect(page.getByTestId("session-in-progress")).toBeVisible();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
}

test("'Start workout' opens live mode with a rest timer (#340)", async ({
  page,
}) => {
  await page.goto("/training?tab=log"); // default "Log" tab renders the Training Log feed

  // The training log aside header carries a "Start workout" button (strength-centric,
  // shown when strength training is relevant). It opens the create editor in live mode.
  await startLiveWorkout(page);

  // The live control strip's rest timer + Finish render (addressed by testid; the
  // editor mounts in the body-level overlay for live mode — see entry-ergonomics'
  // note on why the editor isn't main-scoped).
  const timer = page.getByTestId("rest-timer");
  await expect(timer).toBeVisible();
  await expect(page.getByTestId("finish-workout")).toBeVisible();

  // The countdown shows a m:ss default (no lift picked → the middle default).
  const remaining = page.getByTestId("rest-remaining");
  await expect(remaining).toHaveText(/^\d+:\d\d$/);

  // A preset chip re-targets the countdown (1:30 while idle sets it directly).
  await timer.getByRole("button", { name: "1:30" }).click();
  await expect(remaining).toHaveText("1:30");

  // The start/pause toggle starts the countdown — the control flips to Pause.
  const toggle = page.getByTestId("rest-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "Start rest timer");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "Pause rest timer");

  // Leave the durable live row with an incomplete set. Closing this form would
  // require a discard warning, but minimizing keeps it mounted and loses nothing.
  await pickActivity(page, "Barbell Bench Press");
  await page.getByTestId("set1-weight").fill("60");

  // Escape is another leave gesture, so it parks rather than abandons the live
  // session without presenting the form's destructive-close confirmation.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("workout-dock")).toBeVisible();
  await page.getByTestId("workout-dock-open").click();
  await deleteActivityFromForm(page);
  await page.waitForURL(/\/training(\?.*)?$/);
});

test("checking off a set auto-starts rest, and Finish stamps the end time (#340)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  await startLiveWorkout(page);

  // Pick a lift the seed trains repeatedly so a coached suggestion exists, then
  // TAP "Use" to seed set 1 from it (#1971 retired the focus-fill: arriving in a
  // field is not consent to have it written) — completing the set auto-saves the
  // draft (the Delete button appearing confirms the persist).
  await pickActivity(page, "Barbell Bench Press");
  const weight = page.getByTestId("set1-weight");
  await page
    .getByTestId("next-set-card")
    .getByRole("button", { name: "Use" })
    .click();
  await expect(weight).toHaveValue(/^\d/);
  await expect(
    page.getByRole("button", { name: "Delete", exact: true })
  ).toBeVisible();

  // THE CHECK-OFF IS THE CONFIRM (#5373). Adding a row used to stand in for it, and it
  // fired whether or not the previous set had happened; the grid now opens as the whole
  // plan and each row's ✓ is the gesture. Set 1 is the record the Use tap landed, so
  // row 2 is the next set still on offer.
  const row2 = page.getByTestId("set-row-2"); // testid-scope-ok: the set grid is inside the held editor overlay, one copy
  await row2.getByTestId("set-confirm-2").click();
  await expect(page.getByTestId("rest-toggle")).toHaveAttribute(
    "aria-label",
    "Pause rest timer"
  );

  // The session's own page, held before the finish: create-at-start put the tab
  // here (#2870) and the workspace opened above it.
  const sessionUrl = new URL(page.url()).pathname;

  // Finish now opens the "Session complete" recap step (#924); Save from there
  // stamps end=now and CLOSES the workspace (#5111) rather than collapsing back
  // to the editor for the session it just ended.
  await page.getByTestId("finish-workout").click();
  await expect(page.getByTestId("session-complete-step")).toBeVisible();
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("activity-form")).toHaveCount(0);

  // The end stamp survived the close, read back through a FRESH load of the
  // session's page rather than through whatever the close left on screen. The
  // close consumes the history entry the workspace holds for the phone's Back
  // button (useHistoryBackClose), and that back() keeps the SAME url — the
  // sentinel is a bare pushState — so there is no navigation to wait for and a
  // click issued straight afterwards races the restore. Re-navigating is both
  // the wait and the stronger reading: it costs a server round trip instead of
  // the state still in the form.
  await page.goto(sessionUrl);
  await hydratedClick(page, appContent(page).getByTestId("activity-page-edit"));
  await expect(page.getByTestId("end-time-input")).toHaveValue(/^\d\d:\d\d$/);

  // Clean up the auto-saved draft so the shared seed DB is left untouched.
  await deleteActivityFromForm(page);
  // Deleting the activity from its canonical page leaves that now-dead URL and
  // clears its live presence before the next test shares this worker database.
  await page.waitForURL(/\/training(\?.*)?$/);
  await expect(page.getByTestId("workout-dock")).toHaveCount(0);
});

test("editing another activity resumes an empty live workout without stranding its row", async ({
  page,
}) => {
  await page.goto("/training?tab=log");
  await startLiveWorkout(page);

  await page
    .getByRole("button", { name: "Minimize workout", exact: true })
    .click();
  await page.goBack();
  await page.waitForURL(/\/training\?tab=log$/);

  // SCOPED TO AN ACTIVITY ROW, and followed through its TITLE (#4079). The Log
  // renders the whole Training family through the shared substrate, so an unscoped
  // row can be a milestone or an endurance event, and the row itself is not a link.
  // eslint-disable-next-line no-restricted-properties -- first-ok: live drafts are excluded from the log, so every visible activity row is an older stored one
  const olderActivity = page
    .locator('[data-testid="history-row"][data-history-kind="activity"]')
    .first();
  await hydratedClick(page, olderActivity.getByTestId("history-row-title"));
  await page.waitForURL(/\/training\/activity\/\d+$/);
  await hydratedClick(page, page.getByTestId("activity-page-edit"));
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  await page.getByTestId("finish-workout").click();
  const discarded = page.waitForResponse(
    (response) => response.request().method() === "POST" && response.ok()
  );
  // Save closes the workspace itself now (#5111), through the same guard Done
  // took — and this session logged nothing, so the guard still asks.
  await page.getByTestId("recap-save").click();
  await page
    .getByTestId("confirm-dialog")
    .getByRole("button", { name: "Close anyway", exact: true })
    .click();
  await discarded;
  await expect(page.getByTestId("activity-form")).toHaveCount(0);

  // Closing from the older activity leaves that page in place. A hard navigation
  // proves the empty live row was deleted server-side, not merely hidden locally.
  await page.goto("/training?tab=log");
  await expect(page.getByTestId("workout-dock")).toHaveCount(0);
});

// Issue #1893 — THE EPOCH PIN. `openLive()` used to clear the editor and re-stamp
// `liveStartEpoch` from the wall clock unconditionally, which is exactly the instant the #921
// dock's elapsed timer ticks off: tapping an entry point mid-workout silently reset the
// running session's clock. Every entry point now renders one offer state and resumes.
//
// The assertion is the EPOCH, not the label. The dock prints whole minutes, so a reset
// clock is invisible in the rendered text for a full minute — a label-only assertion
// would pass against the very bug this fixes.
test("mid-session, the workout entry point resumes and the session clock survives (#1893)", async ({
  page,
}) => {
  await page.goto("/training?tab=log");

  const entry = page.getByRole("main").getByTestId("start-workout");
  await expect(entry).toHaveAttribute("data-workout-offer", "start");
  await expect(entry).toHaveText("Start workout");
  await entry.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  // #2870 step 3: the session got its row and the tab stands on its page.
  await page.waitForURL(/\/training\/activity\/\d+$/);

  // Minimize — the form stays MOUNTED and the clock keeps running. Off the
  // Log view, the app-wide bar carries the pocketed session.
  await page
    .getByRole("button", { name: "Minimize workout", exact: true })
    .click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // Back on the Log — SOFT history navigation (the pocketed form must stay
  // mounted; a hard reload would re-derive the epoch from presence's
  // minute-rounded reconstruction). goBack pops the start's own push, landing
  // exactly on the ?tab=log we came from. The SAME entry control now offers
  // the resume by name.
  await page.goBack();
  await page.waitForURL(/tab=log/);
  await expect(entry).toHaveAttribute("data-workout-offer", "resume");
  await expect(entry).toHaveText("Resume workout");

  // Tapping it reopens the running session instead of starting a new one,
  // without taking the reader away from the page beneath the workspace.
  const logUrl = page.url();
  await entry.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  expect(page.url()).toBe(logUrl);
  await page
    .getByRole("button", { name: "Minimize workout", exact: true })
    .click();
  await expect(dock).toBeVisible();
  // The pin: the same start instant, so the same elapsed time continues.
  await expect(dock).toHaveAttribute("data-start-epoch", startedAt!);

  // Restore from the bar and explicitly delete this test's session.
  await page.getByTestId("workout-dock-open").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await deleteActivityFromForm(page);
  await page.waitForURL(/\/training(\?.*)?$/);
  await expect(dock).toHaveCount(0);
});

test("the command palette offers 'Start workout' (#340)", async ({ page }) => {
  await page.goto("/");

  // Retrying open — a raw Ctrl-K fired inside the hydration window is swallowed
  // (issue #500/#501; e2e/nav.ts).
  const input = await openCommandPalette(page);

  await input.fill("start");
  await expect(page.getByTestId("palette-action-start-workout")).toBeVisible();

  // Read-only: close without executing so no draft is created.
  await page.keyboard.press("Escape");
});
