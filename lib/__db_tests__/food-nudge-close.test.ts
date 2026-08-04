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
// send already succeeded; (4) a non-food kind touches neither the pointer nor a strip;
// (5) a send that yields NO pointer strips nothing (#1945 — strip and record are one
// decision, so a send that cannot record must not close anybody's keyboard); (6) across
// three nudges with an unextractable middle one, the strip lands on the message the
// pointer names and the middle one is never orphaned with a live keyboard.

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
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

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
  seedLoginTelegram(p.profileId, CHAT);
  // A staple habit so buildFoodNudge yields a real button-carrying nudge.
  logFood(t, "leafy_greens", 3);
});

beforeEach(() => {
  sendMock.mockClear();
  stripMock.mockClear();
  stripMock.mockImplementation(async () => {});
  // Clear any prior delivery marker + pointer between cases.
  // Delivery-health marker is now the notify_lifecycle row (issue #942).
  db.prepare("DELETE FROM notify_lifecycle").run();
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

  // A food-kind send whose delivered keyboard carries no quick-log token — the #1807
  // "Show less"-only shape, or a keyboard reduced to view controls. It yields no
  // pointer, and a send that cannot record must not strip: it has superseded nothing.
  function viewControlOnlyNudge(): NotificationMessage {
    return {
      title: "🍽️ Midday food log",
      body: "…",
      kind: "food",
      actions: [
        {
          label: "➖ Show less",
          data: `foodless:${p.profileId}:Midday:${t}`,
          row: "food-showmore",
        },
      ],
    };
  }

  it("a send that yields no pointer leaves the previous keyboard intact", async () => {
    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
    const firstPtr = getFoodNudgePointer(p.profileId)!;
    stripMock.mockClear();

    await dispatch(p.profileId, viewControlOnlyNudge());

    // No strip without a successor to record — the pointer still names the message
    // that is still showing its keyboard.
    expect(stripMock).not.toHaveBeenCalled();
    expect(getFoodNudgePointer(p.profileId)).toEqual(firstPtr);
  });

  it("strips the message the pointer names, never the one that stranded it (#1945)", async () => {
    // Three consecutive nudges, the middle one carrying no quick-log token.
    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
    const firstPtr = getFoodNudgePointer(p.profileId)!;

    await dispatch(p.profileId, viewControlOnlyNudge());
    const middleId = sendMock.mock.results.at(-1)!.value as Promise<number>;
    const middleMessageId = await middleId;

    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Evening", t)!);
    const thirdPtr = getFoodNudgePointer(p.profileId)!;

    // Exactly one strip across the run, aimed at the FIRST message — the one the third
    // nudge actually supersedes. Before #1945 the middle send stripped it instead and
    // recorded nothing, so the third stripped the same dead id again and the middle
    // message kept a live keyboard forever.
    expect(stripMock).toHaveBeenCalledTimes(1);
    expect(stripMock.mock.calls[0][1]).toBe(firstPtr.messageId);
    expect(stripMock.mock.calls.map((c) => c[1])).not.toContain(
      middleMessageId
    );

    // ...and the pointer names the newest EXTRACTABLE message at every step.
    expect(thirdPtr.window).toBe("Evening");
    expect(thirdPtr.messageId).toBeGreaterThan(middleMessageId);
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
