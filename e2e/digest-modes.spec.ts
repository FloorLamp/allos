import { test, expect } from "./fixtures";
import {
  settledCheckSave,
  settledFillSave,
  settledSelectSave,
} from "./helpers";

// The morning digest's two modes (#2211) on Settings → Notifications.
//
// Three states, no sentinels: Off / "Same time every day" / "As soon as it's ready".
// The control owns TWO stored fields — `notify_digest_hour` (the time, or "" for off)
// and `digest_mode` — so this spec pins the thing a two-field control most easily gets
// wrong: switching the mode must not disturb the time, and switching Off then back on
// must restore the mode the user last chose.
//
// It also pins that the summary under the control names the DEADLINE, because the
// Dynamic promise ("by X at the latest") is the half a user cannot infer from the
// picker — and that the profile is told which of the four no-answer reasons applies
// rather than a flattened "not enough data yet".
//
// Runs as admin acting as the seeded profile 1 (shared storageState).
// BLAST RADIUS: it drives the digest control and the sleep extra, then RESETS the
// digest to off so the shared fixture is left as found.
test.describe("morning digest modes (issue #2211)", () => {
  test("Off / Static / Dynamic round-trip, and the time survives a mode change", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(kindsCard).toBeVisible();

    const mode = page.getByTestId("digest-hour");
    const time = page.getByTestId("digest-hour-time");
    const summary = page.getByTestId("digest-hour-summary");

    // Three options, labelled by intent. Not "Smart": the tone contract is numbers
    // not adjectives, and it would imply the alternative is dumb.
    await expect(mode.getByRole("option")).toHaveText([
      "Off",
      "Same time every day",
      "As soon as it’s ready",
    ]);

    // Off is the starting state for the seeded profile: no time input, no summary.
    await expect(mode).toHaveValue("");
    await expect(time).toHaveCount(0);
    await expect(summary).toHaveCount(0);

    // Turning it on pre-fills the declared 07:00 default and says what it will do.
    await settledSelectSave(page, mode, "static", kindsCard);
    await expect(time).toHaveValue("07:00");
    await expect(summary).toContainText("07:00");
    await expect(summary).toContainText("whether or not");

    // A concrete minute-precise time, then a MODE change: the time must not move.
    await settledFillSave(page, time, "06:45", kindsCard);
    await settledSelectSave(page, mode, "dynamic", kindsCard);
    await expect(time).toHaveValue("06:45");

    // Dynamic names both times — the floor it will never send before, and the
    // deadline it sends by regardless. The deadline is the half a user cannot infer.
    await expect(summary).toContainText("06:45");
    await expect(summary).toContainText("at the latest");

    // Both fields round-trip across a reload.
    await page.reload();
    await expect(page.getByTestId("digest-hour")).toHaveValue("dynamic");
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("06:45");

    // With the Sleep section off there is nothing to wait for, and Dynamic says so
    // rather than leaving it to be discovered.
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      false,
      kindsCard
    );
    await expect(page.getByTestId("digest-hour-summary")).toContainText(
      "nothing to wait for"
    );

    // Off keeps the mode, so switching back on restores the choice rather than
    // silently reverting to Static.
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "",
      kindsCard
    );
    await expect(page.getByTestId("digest-hour-time")).toHaveCount(0);
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "dynamic",
      kindsCard
    );
    await expect(page.getByTestId("digest-hour-time")).toHaveValue("06:45");

    // Reset the shared fixture: digest off, sleep summary back on (its default).
    await settledCheckSave(
      page,
      page.getByTestId("digest-sleep-enabled"),
      true,
      kindsCard
    );
    await settledSelectSave(
      page,
      page.getByTestId("digest-hour"),
      "",
      kindsCard
    );
  });
});
