import { test, expect } from "./fixtures";
import {
  settledCheck,
  settledCheckSave,
  settledFill,
  settledSelectSave,
} from "./helpers";

// Settings → Notifications after the login-scoping move (issue #1072). Runs
// authenticated as admin acting as the seeded profile 1 (shared storageState).
// Covers the re-homed surfaces:
//   • the LOGIN Telegram channel ("Telegram (your chat)") — enable + chat id + save;
//   • the per-SUBJECT food-logging opt-in, which #1462 §6 moved onto the food row of
//     the consolidated (autosaving) "Message kinds" card;
//   • the per-SUBJECT bedtime watch reminder opt-in (#2161) on the row beside it —
//     off by default, and the only place in the app that can turn it on;
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

    // --- Food opt-in (Message kinds → Food-log nudges) — per-subject ---
    const kindsCard = page.getByTestId("notification-kinds");
    await expect(kindsCard).toBeVisible();
    const foodToggle = page.getByTestId("food-telegram-enabled");
    await expect(foodToggle).toBeVisible();
    await expect(foodToggle).not.toBeChecked(); // off by default
    await settledCheckSave(page, foodToggle, true, kindsCard);

    // --- Bedtime watch reminder (#2161) — the CONSENT for a class-1 send ---
    // It sits on the same autosaving kinds card, one row down, and the assertion that
    // matters most is the first one: OFF by default. Sleep is an observation domain,
    // so nothing here is ever "missed"; this send exists only because the user asked
    // for it, and a default-on would be the contact-consent rule broken at the only
    // place it can be broken.
    const wearRow = kindsCard.getByTestId("kind-row-wear-reminder");
    await expect(wearRow).toContainText("Bedtime watch reminder");
    const wearToggle = page.getByTestId("wear-reminder-enabled");
    await expect(wearToggle).not.toBeChecked();
    await settledCheckSave(page, wearToggle, true, kindsCard);

    // The precondition is NAMED, not guessed at. The reminder's whole schedule is the
    // Bedtime slot minute, and that slot is independently switchable — someone who
    // takes nothing at bedtime turns it off — so consenting to the reminder with the
    // slot off would leave a checkbox reading ON that can never send. Turning the slot
    // off makes the row say so and point at the Schedule card; no fallback hour is
    // invented, because guessing a bedtime for a send the user consented to at THEIR
    // bedtime would be the worse answer.
    const gap = page.getByTestId("kind-slot-gap-wear-reminder");
    await expect(gap).toHaveCount(0);
    const bedtimeMode = page.getByLabel("Bedtime reminder mode");
    await settledSelectSave(page, bedtimeMode, "", kindsCard);
    await expect(gap).toContainText("Bedtime reminder time");
    await expect(gap).toContainText("Schedule");
    // The consent itself is untouched — the note explains, it never rewrites what the
    // user declared, and the box stays editable so a consent can always be withdrawn.
    await expect(wearToggle).toBeChecked();
    await expect(wearToggle).toBeEnabled();
    await settledSelectSave(page, bedtimeMode, "time", kindsCard);
    await expect(gap).toHaveCount(0);

    // --- Per-(login, profile) mute ---
    const muteToggle = page.getByTestId("profile-notify-mute");
    await expect(muteToggle).toBeVisible();
    await settledCheck(page, muteToggle, true);
    await expect(page.getByTestId("profile-notify-mute")).toBeChecked();

    // Persists across a reload.
    await page.reload();
    await expect(page.getByTestId("food-telegram-enabled")).toBeChecked();
    await expect(page.getByTestId("wear-reminder-enabled")).toBeChecked();
    await expect(page.getByTestId("login-telegram-chat-id")).toHaveValue(
      "55501234"
    );
    await expect(page.getByTestId("profile-notify-mute")).toBeChecked();

    // Reset the shared fixture: mute off, food off, chat cleared, Telegram off.
    await settledCheck(page, page.getByTestId("profile-notify-mute"), false);
    await settledCheckSave(
      page,
      page.getByTestId("food-telegram-enabled"),
      false,
      kindsCard
    );
    await settledCheckSave(
      page,
      page.getByTestId("wear-reminder-enabled"),
      false,
      kindsCard
    );
    await settledFill(page, page.getByTestId("login-telegram-chat-id"), "");
    await settledCheck(page, page.getByTestId("login-telegram-enabled"), false);
    await tgCard.getByRole("button", { name: "Save" }).click();
    await expect(tgCard.getByLabel("Saved")).toBeVisible();
  });
});
