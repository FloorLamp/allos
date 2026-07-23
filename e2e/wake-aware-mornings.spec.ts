import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Wake-aware mornings (issue #1117): the "Auto — from your wake time" state on the
// Morning intake slot + the morning digest, and the sleep-summary opt-in, on
// Settings → Notifications. Runs as admin acting as the seeded profile 1 (shared
// storageState). BLAST RADIUS: it enables Telegram to reveal the schedule and
// drives the Morning/digest selects + the sleep toggle, then RESETS them (Morning
// back to Auto — profile 1's default, digest off, sleep off, Telegram off) so the
// shared fixture is left as found. No bot token is configured in the e2e DB, so
// saving never sends anything.
test.describe("wake-aware mornings (issue #1117)", () => {
  test("Auto option + sleep-summary opt-in round-trip", async ({ page }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    const card = page.locator(".card", {
      has: page.getByRole("heading", { name: "Notifications (Telegram)" }),
    });
    await expect(card).toBeVisible();

    // The schedule lives inside the Telegram-enabled block. The enable toggle is a
    // controlled checkbox; a click before hydration is swallowed (#830), so retry
    // clicking until it sticks — a single check() can land in the pre-hydration gap.
    const enableTelegram = card.getByLabel("Enable Telegram notifications");
    await expect(async () => {
      if (!(await enableTelegram.isChecked())) await enableTelegram.click();
      await expect(enableTelegram).toBeChecked();
    }).toPass(); // topass-ok: re-click the controlled Telegram toggle until it sticks checked past the pre-hydration swallow (#830)

    const morning = page.getByTestId("supp-morning-hour");
    const digest = page.getByTestId("digest-hour");
    const sleep = page.getByTestId("digest-sleep-enabled");
    const save = card.getByRole("button", { name: "Save" });

    // The wake-aware option is offered on both the Morning slot and the digest.
    await expect(
      morning.getByRole("option", { name: /Auto — from your wake time/ })
    ).toHaveCount(1);
    await expect(
      digest.getByRole("option", { name: /Auto — from your wake time/ })
    ).toHaveCount(1);

    // Pick a specific Morning hour → it persists as a manual choice.
    await morning.selectOption("9");
    await settledClick(page, save);
    await expect(card.getByLabel("Saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("9");

    // Switch the Morning slot + the digest to Auto, and opt into the sleep summary.
    await page.getByTestId("supp-morning-hour").selectOption("auto");
    await page.getByTestId("digest-hour").selectOption("auto");
    await page.getByTestId("digest-sleep-enabled").check();
    await settledClick(page, card.getByRole("button", { name: "Save" }));
    await expect(card.getByLabel("Saved")).toBeVisible();

    // All three round-trip across a reload.
    await page.reload();
    await expect(page.getByTestId("supp-morning-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-hour")).toHaveValue("auto");
    await expect(page.getByTestId("digest-sleep-enabled")).toBeChecked();

    // Reset the shared fixture: Morning back to Auto (its default), digest off,
    // sleep off, Telegram off.
    await page.getByTestId("digest-hour").selectOption("");
    await page.getByTestId("digest-sleep-enabled").uncheck();
    const disableTelegram = card.getByLabel("Enable Telegram notifications");
    await expect(async () => {
      if (await disableTelegram.isChecked()) await disableTelegram.click();
      await expect(disableTelegram).not.toBeChecked();
    }).toPass(); // topass-ok: re-click the controlled Telegram toggle until it clears unchecked past the pre-hydration swallow (#830)
    await settledClick(page, card.getByRole("button", { name: "Save" }));
    await expect(card.getByLabel("Saved")).toBeVisible();
  });
});
