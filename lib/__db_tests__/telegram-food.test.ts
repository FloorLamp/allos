// DB INTEGRATION TIER — the food-logging Telegram buttons (issue #682) driven end-
// to-end through handleCallbackQuery against the REAL query/write layer, with only
// the Telegram network surface stubbed. Proves a quick-log tap logs one serving via
// the shared write core, an opt-in tap flips the per-profile flag, and a tap from an
// unmapped chat writes NOTHING. The pure parse/render half is covered in
// lib/__tests__/food-callback.test.ts + food-nudge.test.ts.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => {}),
  };
});

import { db, today, yesterday } from "@/lib/db";
import {
  setProfileSetting,
  getProfileFoodTelegram,
  getProfilesByTelegramChatId,
} from "@/lib/settings";
import { getFoodServingsOnDate } from "@/lib/queries";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

const answerMock = vi.mocked(answerCallbackQuery);
const OWN_CHAT = "5550100";
const OTHER_CHAT = "5550299";

function cq(data: string, chatId: string) {
  return {
    id: "cbq-food",
    data,
    message: {
      message_id: 77,
      chat: { id: chatId },
      text: "🍽️ Morning food log",
      reply_markup: { inline_keyboard: [[{ text: "x", callback_data: data }]] },
    },
  };
}

function lastAnswer(): string | undefined {
  return answerMock.mock.calls.at(-1)?.[1];
}

let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("tg-food");
  t = today(p.profileId);
  // Map the profile to a Telegram chat so inbound taps resolve to it.
  seedLoginTelegram(p.profileId, OWN_CHAT);
});

beforeEach(() => {
  answerMock.mockClear();
});

describe("food quick-log tap", () => {
  it("logs one serving and answers with the running count", async () => {
    expect(getProfilesByTelegramChatId(OWN_CHAT)).toContain(p.profileId);

    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:leafy_greens`, OWN_CHAT)
    );
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:leafy_greens`, OWN_CHAT)
    );

    expect(getFoodServingsOnDate(p.profileId, t).get("leafy_greens")).toBe(2);
    expect(lastAnswer()).toContain("Leafy greens ×2");
  });

  it("writes nothing for a tap from an unmapped chat", async () => {
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Midday:${t}:berries`, OTHER_CHAT)
    );
    expect(
      getFoodServingsOnDate(p.profileId, t).get("berries")
    ).toBeUndefined();
  });
});

describe("food quick-log cross-date guard (#947)", () => {
  it("refuses a tap on YESTERDAY's stale nudge — writes nothing, answers honestly", async () => {
    const y = yesterday(p.profileId);
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Evening:${y}:berries`, OWN_CHAT)
    );
    // Nothing logged on yesterday OR today from the stale tap.
    expect(
      getFoodServingsOnDate(p.profileId, y).get("berries")
    ).toBeUndefined();
    expect(
      getFoodServingsOnDate(p.profileId, t).get("berries")
    ).toBeUndefined();
    // Honest answer, never a false confirm.
    expect(lastAnswer()).toContain(y);
    expect(lastAnswer()).not.toContain("Logged ✅");
  });

  it("still logs a same-day tap from an OLDER window (the date is right)", async () => {
    // A Morning-window token whose date is TODAY logs normally even if tapped later
    // in the day — only cross-DATE taps are refused, not cross-window.
    await handleCallbackQuery(
      cq(`food:${p.profileId}:Morning:${t}:whole_grains`, OWN_CHAT)
    );
    expect(getFoodServingsOnDate(p.profileId, t).get("whole_grains")).toBe(1);
    expect(lastAnswer()).toContain("Logged ✅");
  });
});

describe("food opt-in prompt tap", () => {
  it("Enable flips the flag on; No thanks flips it off", async () => {
    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:yes`, OWN_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(true);

    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:no`, OWN_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(false);
  });

  it("ignores an opt-in tap from an unmapped chat", async () => {
    await handleCallbackQuery(cq(`foodoptin:${p.profileId}:yes`, OTHER_CHAT));
    expect(getProfileFoodTelegram(p.profileId)).toBe(false);
  });
});
