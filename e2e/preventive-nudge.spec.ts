import { test, expect } from "@playwright/test";
import { settledCheck } from "./helpers";

// Per-profile preventive-care reminders toggle on Settings → Profile (issue #87).
// Runs authenticated as admin acting as the seeded profile 1 (shared storageState).
// The toggle lives inside the Telegram notifications block, so the spec enables
// Telegram to reveal it, flips the toggle, and confirms it round-trips through
// profile_settings — then restores the fixture (preventive ON, Telegram OFF) so the
// shared DB is left as it was found. Does NOT touch e2e/preventive-upcoming.spec.ts
// fixtures or seeded rows.
test.describe("preventive-care reminders toggle (issue #87)", () => {
  test("defaults on and round-trips off through profile_settings", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/notifications");

    // The schedule (and the preventive toggle) is revealed only when Telegram is
    // enabled for this profile — turn it on first. settledCheck waits for React to
    // hydrate the controlled checkbox (a pre-hydration .check() reverts — #1188).
    await settledCheck(
      page,
      page.getByLabel("Enable Telegram notifications"),
      true
    );

    const toggle = page.getByTestId("preventive-enabled");
    await expect(toggle).toBeVisible();
    // Default ON — no per-profile setting stored yet.
    await expect(toggle).toBeChecked();

    // Turn it off and save.
    await settledCheck(page, toggle, false);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic

    // Reload — Telegram is now enabled (so the block shows) and the preventive
    // toggle persists OFF from profile_settings.
    await page.reload();
    await expect(page.getByTestId("preventive-enabled")).not.toBeChecked();

    // Restore the fixture: preventive back ON, Telegram back OFF, then save. The
    // preventive state persists even while its checkbox is hidden by the Telegram
    // toggle, so the form still submits preventive_enabled=1.
    await settledCheck(page, page.getByTestId("preventive-enabled"), true);
    await settledCheck(
      page,
      page.getByLabel("Enable Telegram notifications"),
      false
    );
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears — order-agnostic

    await page.reload();
    await expect(
      page.getByLabel("Enable Telegram notifications")
    ).not.toBeChecked();
  });
});
