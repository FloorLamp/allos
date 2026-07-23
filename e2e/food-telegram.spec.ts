import { test, expect } from "@playwright/test";
import { settledCheck, settledFill } from "./helpers";

// Settings → Notifications after the login-scoping move (issue #1072). Runs
// authenticated as admin acting as the seeded profile 1 (shared storageState).
// Covers the re-homed surfaces:
//   • the LOGIN Telegram channel ("Telegram (your chat)") — enable + chat id + save;
//   • the per-SUBJECT food-logging opt-in, now always visible under "Reminders &
//     schedule" (no longer gated behind the per-profile Telegram toggle);
//   • the per-(login, profile) mute toggle.
// BLAST RADIUS: it toggles the login channel + food + mute, then RESETS them at the
// end, leaving the shared fixture as found. No bot token is configured in the e2e DB,
// so saving never sends a notification.
test.describe("notification settings — login-scoped channels (issue #1072)", () => {
  test("login Telegram channel, food opt-in, and per-profile mute round-trip", async ({
    page,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    await page.goto("/settings/notifications");

    // --- LOGIN Telegram channel (This login) ---
    const tgCard = page.locator(".card", {
      has: page.getByRole("heading", { name: "Telegram (your chat)" }),
    });
    await expect(tgCard).toBeVisible();
    const enableTelegram = page.getByTestId("login-telegram-enabled");
    await settledCheck(page, enableTelegram, true);
    await settledFill(
      page,
      page.getByTestId("login-telegram-chat-id"),
      "55501234"
    );
    await tgCard.getByRole("button", { name: "Save" }).click();
    await expect(tgCard.getByLabel("Saved")).toBeVisible();

    // --- Food opt-in (Reminders & schedule) — always visible, per-subject ---
    const scheduleCard = page.locator(".card", {
      has: page.getByRole("heading", { name: "Reminders & schedule" }),
    });
    const foodToggle = page.getByTestId("food-telegram-enabled");
    await expect(foodToggle).toBeVisible();
    await expect(foodToggle).not.toBeChecked(); // off by default
    await settledCheck(page, foodToggle, true);
    await scheduleCard.getByRole("button", { name: "Save" }).click();
    await expect(scheduleCard.getByLabel("Saved")).toBeVisible();

    // --- Per-(login, profile) mute ---
    const muteToggle = page.getByTestId("profile-notify-mute");
    await expect(muteToggle).toBeVisible();
    await settledCheck(page, muteToggle, true);
    await expect(page.getByTestId("profile-notify-mute")).toBeChecked();

    // Persists across a reload.
    await page.reload();
    await expect(page.getByTestId("food-telegram-enabled")).toBeChecked();
    await expect(page.getByTestId("login-telegram-chat-id")).toHaveValue(
      "55501234"
    );
    await expect(page.getByTestId("profile-notify-mute")).toBeChecked();

    // Reset the shared fixture: mute off, food off, chat cleared, Telegram off.
    await settledCheck(page, page.getByTestId("profile-notify-mute"), false);
    await settledCheck(page, page.getByTestId("food-telegram-enabled"), false);
    await scheduleCard.getByRole("button", { name: "Save" }).click();
    await expect(scheduleCard.getByLabel("Saved")).toBeVisible();
    await settledFill(page, page.getByTestId("login-telegram-chat-id"), "");
    await settledCheck(page, page.getByTestId("login-telegram-enabled"), false);
    await tgCard.getByRole("button", { name: "Save" }).click();
    await expect(tgCard.getByLabel("Saved")).toBeVisible();
  });
});
