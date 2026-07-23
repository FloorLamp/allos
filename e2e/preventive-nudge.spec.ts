import { test, expect } from "@playwright/test";
import { settledCheck } from "./helpers";

// Per-profile preventive-care reminders toggle on Settings → Notifications (issue
// #87). Runs authenticated as admin acting as the seeded profile 1 (shared
// storageState). As of #1072 the toggle is per-SUBJECT and always visible under
// "Reminders & schedule" (no longer gated behind a per-profile Telegram toggle). The
// spec flips it and confirms it round-trips through profile_settings — then restores
// the fixture (preventive ON) so the shared DB is left as it was found.
test.describe("preventive-care reminders toggle (issue #87)", () => {
  test("defaults on and round-trips off through profile_settings", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/notifications");

    const card = page.locator(".card", {
      has: page.getByRole("heading", { name: "Reminders & schedule" }),
    });
    const toggle = page.getByTestId("preventive-enabled");
    await expect(toggle).toBeVisible();
    // Default ON — no per-profile setting stored yet.
    await expect(toggle).toBeChecked();

    // Turn it off and save.
    await settledCheck(page, toggle, false);
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByLabel("Saved")).toBeVisible();

    // Reload — the preventive toggle persists OFF from profile_settings.
    await page.reload();
    await expect(page.getByTestId("preventive-enabled")).not.toBeChecked();

    // Restore the fixture: preventive back ON, then save.
    await settledCheck(page, page.getByTestId("preventive-enabled"), true);
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByLabel("Saved")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("preventive-enabled")).toBeChecked();
  });
});
