import { test, expect } from "@playwright/test";

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
      "Urgent medication reminders are never held"
    );

    // Scope Save + its "Saved" chip to the notifications card (the page has other
    // forms with their own Save buttons).
    const notifCard = page.locator(".card", { has: quiet });
    const saveNotif = notifCard.getByRole("button", { name: "Save" });

    // Shift to a night-shift overnight window (20:00 → 08:00).
    await page.getByTestId("waking-start-hour").selectOption("20");
    await page.getByTestId("waking-end-hour").selectOption("8");
    await saveNotif.click();
    await expect(notifCard.getByLabel("Saved")).toBeVisible();

    // Reload — the bounds round-trip from profile_settings.
    await page.reload();
    await expect(page.getByTestId("waking-start-hour")).toHaveValue("20");
    await expect(page.getByTestId("waking-end-hour")).toHaveValue("8");

    // Reset to the 8→21 default, leaving the shared fixture as we found it.
    await page.getByTestId("waking-start-hour").selectOption("8");
    await page.getByTestId("waking-end-hour").selectOption("21");
    await page
      .locator(".card", { has: page.getByTestId("quiet-hours") })
      .getByRole("button", { name: "Save" })
      .click();
    await expect(
      page
        .locator(".card", { has: page.getByTestId("quiet-hours") })
        .getByLabel("Saved")
    ).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("waking-start-hour")).toHaveValue("8");
    await expect(page.getByTestId("waking-end-hour")).toHaveValue("21");
  });
});
