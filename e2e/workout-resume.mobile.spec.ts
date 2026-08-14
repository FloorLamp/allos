import { test, expect } from "./fixtures";
import { openLogSheet, showLogRow } from "./log-sheet-helpers";

// Issue #1893/#2745 at the PHONE viewport — the Train segment's workout row. Its
// visible label IS the offer: while a
// session is running it must read "Resume workout" and reopen the docked session, because
// `openLive()` used to clear the editor and re-stamp `liveStartEpoch` from the wall clock — the
// exact instant the #921 dock's elapsed timer ticks off.
//
// The assertion that proves the corruption is gone is the EPOCH, not the label: the dock
// prints whole minutes, so a reset clock stays invisible in the rendered text for a full
// minute and a label-only test would pass against the bug.
test("the sheet's workout row resumes a running session with its clock intact (#1893/#2745)", async ({
  page,
}) => {
  await page.goto("/training");

  const sheet = await openLogSheet(page);
  const workout = await showLogRow(sheet, "live-workout");
  await expect(workout).toContainText("Start workout");
  await expect(workout).toHaveAttribute("data-workout-offer", "start");
  await workout.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Pocket the session: the form stays MOUNTED (rest timer and elapsed clock running)
  // and the app-wide dock carries it.
  await page.getByTestId("minimize-workout").click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // The row now offers Resume through the same workoutOffer derivation.
  const resumedSheet = await openLogSheet(page);
  const resume = await showLogRow(resumedSheet, "live-workout");
  await expect(resume).toContainText("Resume workout");
  await expect(resume).toHaveAttribute("data-workout-offer", "resume");

  // Tapping it reopens the running session rather than starting a new one...
  await resume.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.getByTestId("minimize-workout").click();
  await expect(dock).toBeVisible();
  // ...and the session clock is the same one, so the same elapsed time continues.
  await expect(dock).toHaveAttribute("data-start-epoch", startedAt!);

  // No set was logged, so nothing auto-saved — restore and close without a draft.
  await page.getByTestId("workout-dock-open").click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dock).toHaveCount(0);
});
