// SERVER-ACTION TIER — the food-logging-over-Telegram opt-in (issue #682) and its
// one-time first-connection prompt. As of #1072 the Telegram channel is LOGIN-scoped,
// so the first-connection prompt fires from saveLoginTelegram (login tier); the
// per-profile food_telegram_enabled flag still round-trips through saveNotificationPrefs
// (profile tier). Proves the flag round-trips, and that the prompt fires (and marks
// itself prompted) exactly once, only when the login's Telegram is actually
// connectable. The Telegram network transport is stubbed.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return { ...actual, sendMessageRaw: vi.fn(async () => {}) };
});

import { revalidatePath } from "next/cache";
import { saveNotificationPrefs } from "@/app/(app)/settings/profile/actions";
import { saveLoginTelegram } from "@/app/(app)/settings/actions";
import {
  getProfileFoodTelegram,
  getFoodTelegramPrompted,
  setTelegramBotConfig,
} from "@/lib/settings";
import { sendMessageRaw } from "@/lib/notifications/telegram-api";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const sendMock = vi.mocked(sendMessageRaw);

beforeEach(() => {
  revalidate.mockClear();
  sendMock.mockClear();
  // A global bot token so the login's channel can be "fully connectable" (the prompt
  // only fires when a send could actually go out).
  setTelegramBotConfig({
    telegramBotToken: "test:token",
    telegramMode: "poll",
  });
});

describe("food logging opt-in flag (profile tier)", () => {
  it("round-trips the food_telegram_enabled flag through saveNotificationPrefs", async () => {
    const login = createLogin();
    const profile = createProfile("food-tg", login.id);
    actAs(login, profile);

    expect(getProfileFoodTelegram(profile.id)).toBe(false); // off by default

    await saveNotificationPrefs(fd({ food_telegram_enabled: "1" }));
    expect(getProfileFoodTelegram(profile.id)).toBe(true);

    await saveNotificationPrefs(fd({ food_telegram_enabled: "0" }));
    expect(getProfileFoodTelegram(profile.id)).toBe(false);
  });
});

describe("first-connection food prompt (login tier, #1072)", () => {
  it("marks the first-connection prompt sent so it never re-nags", async () => {
    const login = createLogin();
    const profile = createProfile("food-tg-prompt", login.id);
    actAs(login, profile);

    expect(getFoodTelegramPrompted(profile.id)).toBe(false);

    // First fully-connected channel save sends the opt-in prompt once (for the
    // acting profile) and flips the marker.
    await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "111222333" })
    );
    expect(getFoodTelegramPrompted(profile.id)).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A second save must NOT re-prompt (marker guard).
    await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "111222333" })
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when Telegram isn't actually connected", async () => {
    const login = createLogin();
    const profile = createProfile("food-tg-off", login.id);
    actAs(login, profile);

    // Enabled but no chat id → not connectable → no prompt.
    await saveLoginTelegram(
      fd({ telegram_enabled: "1", telegram_chat_id: "" })
    );
    expect(getFoodTelegramPrompted(profile.id)).toBe(false);
  });
});
