// DB INTEGRATION TIER — the food-nudge close-previous keyboard mechanism (#947),
// driven through the REAL dispatch() → Telegram channel chokepoint with only the
// Telegram network surface stubbed. Each food slot sends a fresh message with live
// serving buttons; every previous nudge's keyboard stays live forever, so tapping a
// stale keyboard would silently log to an old date. The fix: on each new food-nudge
// send, record the message as the per-profile pointer and strip the PREVIOUS one's
// keyboard through the chokepoint.
//
// Proves: (1) a food send stores the pointer; (2) the next send strips the previous
// message's keyboard via editMessageReplyMarkupRaw and rotates the pointer; (3) a
// strip failure (simulated 400) is swallowed and never sets notify_last_error — the
// send already succeeded; (4) a non-food kind touches neither the pointer nor a strip.

import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

// Stub the Telegram transport. sendMessageRaw returns an incrementing message id (so
// the rotation has a handle to close); editMessageReplyMarkupRaw records the strip.
let nextMessageId = 100;
vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    sendMessageRaw: vi.fn(async () => nextMessageId++),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import {
  setSetting,
  setProfileSetting,
  getFoodNudgePointer,
} from "@/lib/settings";
import { dispatch, getNotifyError } from "@/lib/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import {
  sendMessageRaw,
  editMessageReplyMarkupRaw,
} from "@/lib/notifications/telegram-api";
import type { NotificationMessage } from "@/lib/notifications/types";
import { seedProfile, type SeededProfile } from "./fixtures";

const sendMock = vi.mocked(sendMessageRaw);
const stripMock = vi.mocked(editMessageReplyMarkupRaw);
const CHAT = "5550100";

let p: SeededProfile;
let t: string;

function logFood(date: string, group: string, n: number) {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)`
  ).run(p.profileId, date, group, n);
}

beforeAll(() => {
  p = seedProfile("food-close");
  t = today(p.profileId);
  // Telegram configured for this profile (global token + per-profile enable + chat).
  setSetting("telegram_bot_token", "test-bot-token");
  setProfileSetting(p.profileId, "telegram_enabled", "1");
  setProfileSetting(p.profileId, "telegram_chat_id", CHAT);
  // A staple habit so buildFoodNudge yields a real button-carrying nudge.
  logFood(t, "leafy_greens", 3);
});

beforeEach(() => {
  sendMock.mockClear();
  stripMock.mockClear();
  stripMock.mockImplementation(async () => {});
  // Clear any prior delivery marker + pointer between cases.
  setSetting("notify_last_error", "");
  setSetting("notify_last_error_at", "");
  setSetting("notify_last_error_channel", "");
  setProfileSetting(p.profileId, "food_nudge_last_message", "");
});

describe("food nudge close-previous keyboard (#947)", () => {
  it("first send stores the pointer and strips nothing (none prior)", async () => {
    const nudge = buildFoodNudge(p.profileId, "Morning", t)!;
    await dispatch(p.profileId, nudge);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(stripMock).not.toHaveBeenCalled();

    const ptr = getFoodNudgePointer(p.profileId);
    expect(ptr).not.toBeNull();
    expect(ptr!.date).toBe(t);
    expect(ptr!.window).toBe("Morning");
    expect(String(ptr!.chatId)).toBe(CHAT);
    expect(typeof ptr!.messageId).toBe("number");
  });

  it("next send strips the PREVIOUS message's keyboard and rotates the pointer", async () => {
    const first = buildFoodNudge(p.profileId, "Morning", t)!;
    await dispatch(p.profileId, first);
    const firstPtr = getFoodNudgePointer(p.profileId)!;

    const second = buildFoodNudge(p.profileId, "Midday", t)!;
    await dispatch(p.profileId, second);

    // The previous message id was stripped in the previous chat, to an empty keyboard.
    expect(stripMock).toHaveBeenCalledTimes(1);
    const [chatArg, msgArg, kbArg] = stripMock.mock.calls[0];
    expect(String(chatArg)).toBe(CHAT);
    expect(msgArg).toBe(firstPtr.messageId);
    expect(kbArg).toEqual([]);

    // The pointer now points at the SECOND (newer) message + its window.
    const secondPtr = getFoodNudgePointer(p.profileId)!;
    expect(secondPtr.window).toBe("Midday");
    expect(secondPtr.messageId).toBe(firstPtr.messageId + 1);
  });

  it("swallows a strip failure and NEVER sets notify_last_error (send succeeded)", async () => {
    // Prime a pointer, then make the strip throw a 400 on the next send.
    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
    stripMock.mockImplementation(async () => {
      throw new Error("Bad Request: message to edit not found");
    });

    const results = await dispatch(
      p.profileId,
      buildFoodNudge(p.profileId, "Evening", t)!
    );

    // The Telegram send is still healthy — the failed strip is best-effort only.
    expect(results.find((r) => r.id === "telegram")?.ok).toBe(true);
    expect(getNotifyError()).toBeNull();
    // ...and the pointer still rotated to the newest message despite the strip throw.
    expect(getFoodNudgePointer(p.profileId)!.window).toBe("Evening");
  });

  it("a non-food kind neither strips nor writes the pointer", async () => {
    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
    stripMock.mockClear();

    const doseMsg: NotificationMessage = {
      title: "Morning supplements",
      body: "Time for your morning supplements.",
      kind: "dose",
    };
    await dispatch(p.profileId, doseMsg);

    expect(stripMock).not.toHaveBeenCalled();
    // Pointer unchanged — still the Morning food nudge.
    expect(getFoodNudgePointer(p.profileId)!.window).toBe("Morning");
  });
});
