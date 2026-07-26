import { test, expect } from "@playwright/test";
import { settledSelectSave } from "./helpers";

// Quiet hours on Settings → Notifications (issue #450). #440 hardcoded the waking window
// (8→21) that gates non-urgent EPISODE nudges (refill, preventive, milestone); this
// makes it a per-profile setting. Runs authenticated as admin acting as the seeded
// profile 1 (shared storageState). BLAST RADIUS: it edits only the profile's own
// notify_waking_start / notify_waking_end and RESETS them to the 8→21 default at the
// end, so it leaves the shared fixture exactly as found — no other spec reads these
// two keys, and it never sends a notification.
test.describe("quiet hours (issue #450)", () => {
  test("edits the waking window and persists it across reloads", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/notifications");

    const quiet = page.getByTestId("quiet-hours");
    await expect(quiet).toBeVisible();
    // The safety carve-out is stated in the UI.
    await expect(quiet).toContainText(
      /urgent medication reminders are never held/i
    );

    // Quiet hours live on the Schedule card, which AUTOSAVES on change (#1462 §6
    // folded the old mega-card's explicit Save into the Settings convention), so each
    // edit is settled against that card before the reload below.
    const schedule = page.getByTestId("notify-schedule");

    // Shift to a night-shift overnight window (20:00 → 08:00).
    await settledSelectSave(
      page,
      page.getByTestId("waking-start-hour"),
      "20",
      schedule
    );
    await settledSelectSave(
      page,
      page.getByTestId("waking-end-hour"),
      "8",
      schedule
    );

    // Reload — the bounds round-trip from profile_settings.
    await page.reload();
    await expect(page.getByTestId("waking-start-hour")).toHaveValue("20");
    await expect(page.getByTestId("waking-end-hour")).toHaveValue("8");

    // Reset to the 8→21 default, leaving the shared fixture as we found it.
    await settledSelectSave(
      page,
      page.getByTestId("waking-start-hour"),
      "8",
      schedule
    );
    await settledSelectSave(
      page,
      page.getByTestId("waking-end-hour"),
      "21",
      schedule
    );
    await page.reload();
    await expect(page.getByTestId("waking-start-hour")).toHaveValue("8");
    await expect(page.getByTestId("waking-end-hour")).toHaveValue("21");
  });
});
