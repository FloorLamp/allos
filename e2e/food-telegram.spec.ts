import { test, expect } from "@playwright/test";
import { settledCheck, settledFill } from "./helpers";

// Food logging over Telegram — the per-profile opt-in toggle on Settings → Notifications
// (issue #682). Runs authenticated as admin acting as the seeded profile 1 (shared
// storageState). BLAST RADIUS: it enables Telegram + the food toggle to exercise the
// control, then RESETS the profile's telegram_enabled / telegram_chat_id /
// food_telegram_enabled back to off/empty at the end, leaving the shared fixture as
// found. No bot token is configured in the e2e DB, so saving never sends a
// notification (the first-connection prompt is gated on a configured bot).
test.describe("food logging over Telegram (issue #682)", () => {
  test("opt-in toggle appears under Telegram and round-trips", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    const card = page.locator(".card", {
      has: page.getByRole("heading", { name: "Notifications (Telegram)" }),
    });
    await expect(card).toBeVisible();

    // The food toggle lives inside the Telegram-enabled block, so turn Telegram on.
    // settledCheck waits for React to hydrate the controlled checkbox before toggling —
    // a pre-hydration .check() reverts and Playwright reports "did not change its state"
    // (the #1188 fill-revert class, checkbox form; was the food-telegram line-26 flake).
    const enableTelegram = card.getByLabel("Enable Telegram notifications");
    await settledCheck(page, enableTelegram, true);

    const foodToggle = page.getByTestId("food-telegram-enabled");
    await expect(foodToggle).toBeVisible();
    await expect(foodToggle).not.toBeChecked(); // off by default

    // Opt in + a chat id, then save. The chat-id is a controlled input whose Save reads
    // state, so settledFill it too (a pre-hydration fill persists empty — same class).
    await settledCheck(page, foodToggle, true);
    await settledFill(
      page,
      card.getByPlaceholder("e.g. 987654321"),
      "55501234"
    );
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByLabel("Saved")).toBeVisible();

    // The opt-in persists across a reload.
    await page.reload();
    await expect(page.getByTestId("food-telegram-enabled")).toBeChecked();

    // Reset the shared fixture: food off, chat id cleared, Telegram off.
    await settledCheck(page, page.getByTestId("food-telegram-enabled"), false);
    await settledFill(page, card.getByPlaceholder("e.g. 987654321"), "");
    await settledCheck(
      page,
      card.getByLabel("Enable Telegram notifications"),
      false
    );
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByLabel("Saved")).toBeVisible();
  });
});
