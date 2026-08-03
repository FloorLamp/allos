import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { openCommandPalette } from "./nav";

// Issue #340: live workout mode — the in-gym presentation of the SAME activity
// editor (no second engine), driven end-to-end against the seeded DB.
//
//   1. "Start workout" (journal aside + command palette) opens a create form in
//      the live layout: a control strip with the rest timer + Finish.
//   2. The rest timer is a client-side countdown — a lift-appropriate default,
//      preset chips, and a start/pause toggle.
//   3. Checking off a set (adding the next set) auto-starts the rest timer.
//   4. "Finish workout" stamps end=now and collapses back to the plain form.

// Pick an activity in the editor's exercise combobox (same shape-tolerant matcher
// the entry-ergonomics spec documents).
async function pickActivity(page: Page, name: string) {
  await page.getByPlaceholder(/What did you do/).fill(name);
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: name })
    .first() // first-ok: transient combobox list this spec just opened by typing `name`; the first filtered match is the intended option
    .click();
}

test("'Start workout' opens live mode with a rest timer (#340)", async ({
  page,
}) => {
  await page.goto("/training"); // default "Log" tab renders the Journal feed

  // The journal aside header carries a "Start workout" button (strength-centric,
  // shown for non-restricted profiles). It opens the create editor in live mode.
  await page.getByRole("main").getByTestId("start-workout").click();

  // The live control strip + rest timer render (addressed by testid; the editor
  // mounts in the body-level overlay for live mode — see entry-ergonomics' note
  // on why the editor isn't main-scoped).
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
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

  // No set was logged, so nothing auto-saved — close without a draft to clean up.
  await page.keyboard.press("Escape");
});

test("checking off a set auto-starts rest, and Finish stamps the end time (#340)", async ({
  page,
}) => {
  await page.goto("/training");

  await page.getByRole("main").getByTestId("start-workout").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

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

  // Check off the set by adding the next one (Enter in a complete reps field, or
  // the +Add set button) — in live mode this starts the rest countdown.
  await page.getByRole("button", { name: "+ Add set" }).click();
  await expect(page.getByTestId("rest-toggle")).toHaveAttribute(
    "aria-label",
    "Pause rest timer"
  );

  // Finish now opens the "Session complete" recap step (#924); Save from there
  // stamps end=now and collapses the live strip back to the plain form.
  await page.getByTestId("finish-workout").click();
  await expect(page.getByTestId("session-complete-step")).toBeVisible();
  await page.getByTestId("recap-save").click();
  await expect(page.getByTestId("live-workout-panel")).toHaveCount(0);
  await expect(page.getByTestId("session-complete-step")).toHaveCount(0);
  await expect(page.getByTestId("end-time-input")).toHaveValue(/^\d\d:\d\d$/);

  // Clean up the auto-saved draft so the shared seed DB is left untouched.
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
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
  await page.goto("/training");

  const entry = page.getByRole("main").getByTestId("start-workout");
  await expect(entry).toHaveAttribute("data-workout-offer", "start");
  await expect(entry).toHaveText("Start workout");
  await entry.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Minimize to the dock — the form stays MOUNTED and the clock keeps running.
  await page.getByTestId("minimize-workout").click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // The SAME control now offers the resume, and says so.
  await expect(entry).toHaveAttribute("data-workout-offer", "resume");
  await expect(entry).toHaveText("Resume workout");

  // Tapping it reopens the running session instead of starting a new one.
  await entry.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.getByTestId("minimize-workout").click();
  await expect(dock).toBeVisible();
  // The pin: the same start instant, so the same elapsed time continues.
  await expect(dock).toHaveAttribute("data-start-epoch", startedAt!);

  // No set was logged, so nothing auto-saved — restore and close without a draft.
  await page.getByTestId("workout-dock-open").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.keyboard.press("Escape");
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
