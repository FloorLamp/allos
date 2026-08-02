import { test, expect } from "./fixtures";

// Issue #1893 at the PHONE viewport — the mobile bar's bolt, the entry point the issue
// names first. It is an icon-only control, so its accessible name IS its label: while a
// session is running it must read "Resume workout" and reopen the docked session, because
// `openLive()` used to clear the editor and re-stamp `liveStartEpoch = Date.now()` — the
// exact instant the #921 dock's elapsed timer ticks off.
//
// The assertion that proves the corruption is gone is the EPOCH, not the label: the dock
// prints whole minutes, so a reset clock stays invisible in the rendered text for a full
// minute and a label-only test would pass against the bug.
test("the mobile bolt resumes a running session with its clock intact (#1893)", async ({
  page,
}) => {
  await page.goto("/training");

  const bolt = page.getByTestId("start-workout-mobile");
  await expect(bolt).toBeVisible();
  await expect(bolt).toHaveAttribute("aria-label", "Start workout");
  await expect(bolt).toHaveAttribute("title", "Start workout");
  await bolt.click();
  await expect(page.getByTestId("live-workout-panel")).toBeVisible();

  // Pocket the session: the form stays MOUNTED (rest timer and elapsed clock running)
  // and the app-wide dock carries it.
  await page.getByTestId("minimize-workout").click();
  const dock = page.getByTestId("workout-dock");
  await expect(dock).toBeVisible();
  const startedAt = await dock.getAttribute("data-start-epoch");
  expect(startedAt).toMatch(/^\d+$/);

  // The bolt now offers the resume — both the accessible name and the hover tooltip,
  // since an icon-only button owes the user both.
  await expect(bolt).toHaveAttribute("aria-label", "Resume workout");
  await expect(bolt).toHaveAttribute("title", "Resume workout");
  await expect(bolt).toHaveAttribute("data-workout-offer", "resume");

  // Tapping it reopens the running session rather than starting a new one...
  await bolt.click();
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
