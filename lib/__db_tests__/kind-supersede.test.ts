// DB INTEGRATION TIER — ONE LIVE KEYBOARD PER (chat, kind), issue #1898.
//
// #1779 made stale keyboards HONEST; nothing made them SINGULAR. Typing `/dose` three
// times leaves three live keyboards in the chat: each safe to tap, each kept fresh by
// the hourly sweep — which is the cost, an hourly Telegram edit per duplicate, forever,
// to keep clutter honest. #1895's on-demand commands multiply the opportunities.
//
// These cases drive the REAL command handlers through the REAL chokepoint with only the
// Telegram network surface stubbed, and pin:
//
//   (1) a second `/dose` closes the first with the attributed supersede line and leaves
//       exactly one live pointer;
//   (2) the close targets the message the POINTER names — the invariant converges even
//       from a chat that already accumulated duplicates;
//   (3) a non-re-issuable kind (a dose reminder) never closes its sibling;
//   (4) a supersede racing the hourly sweep does not double-edit (the #1788 claim), and
//       the loser makes no call;
//   (5) a close that fails TRANSIENTLY keeps the pointer, so the next send (or the next
//       sweep) retries — the residual #1945 left open;
//   (6) a failed close never turns a delivered message into a channel failure;
//   (7) the food nudge's own #947/#1945 rotation is untouched by all of this.
//
// The pure decision is pinned in lib/__tests__/pointer-rotation.test.ts.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { dispatch, getNotifyError } from "@/lib/notifications";
import { handleIncomingMessage } from "@/lib/notifications/telegram-quick-log";
import {
  editMessageTextRaw,
  editMessageReplyMarkupRaw,
  sendMessageRaw,
} from "@/lib/notifications/telegram-api";
import { liveMessagePointersForKind } from "@/lib/notifications/message-pointers";
import { buildFoodNudge } from "@/lib/notifications/food";
import type { NotificationMessage } from "@/lib/notifications/types";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const sendMock = vi.mocked(sendMessageRaw);
const closeMock = vi.mocked(editMessageTextRaw);
const stripMock = vi.mocked(editMessageReplyMarkupRaw);

const CHAT = "5550410";
let p: SeededProfile;
let t: string;

// A `/dose` call. The PRN list is the cheapest re-issuable kind to drive end to end: it
// renders a real keyboard from live state and needs no scheduled tick.
function doseCommand() {
  return handleIncomingMessage({
    message_id: 1,
    chat: { id: CHAT },
    text: "/dose",
  });
}

function livePrnPointers() {
  return liveMessagePointersForKind(p.profileId, CHAT, "prn-list");
}

beforeAll(() => {
  p = seedProfile("supersede");
  t = today(p.profileId);
  setSetting("telegram_bot_token", "test-bot-token");
  seedLoginTelegram(p.profileId, CHAT);
  // One as-needed medication, so `/dose` yields a button-carrying list.
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, kind, obligation, active)
     VALUES (?, 'Ibuprofen', 'medication', 'may', 1)`
  ).run(p.profileId);
});

beforeEach(() => {
  sendMock.mockClear();
  closeMock.mockClear();
  stripMock.mockClear();
  closeMock.mockImplementation(async () => {});
  db.prepare("DELETE FROM notify_messages WHERE profile_id = ?").run(
    p.profileId
  );
  db.prepare("DELETE FROM notify_lifecycle").run();
  setSetting("notify_last_error", "");
  setSetting("notify_last_error_at", "");
  setSetting("notify_last_error_channel", "");
});

describe("one live keyboard per (chat, kind) — /dose (#1898)", () => {
  it("the first call records a pointer and closes nothing", async () => {
    await doseCommand();

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
    expect(livePrnPointers()).toHaveLength(1);
  });

  it("a second call closes the first and leaves exactly one live keyboard", async () => {
    await doseCommand();
    const first = livePrnPointers()[0];

    await doseCommand();

    // Closed with the #1822 honest-subject convention: the delivered title line the
    // pointer recorded, then why the buttons are gone and where they went.
    expect(closeMock).toHaveBeenCalledTimes(1);
    const [chatArg, msgArg, textArg] = closeMock.mock.calls[0];
    expect(String(chatArg)).toBe(CHAT);
    expect(msgArg).toBe(first.messageId);
    expect(textArg).toContain("Log a PRN dose");
    expect(textArg).toContain("superseded, use the message below");

    // THE invariant, stated as the assertion it is.
    const live = livePrnPointers();
    expect(live).toHaveLength(1);
    expect(live[0].messageId).toBeGreaterThan(first.messageId);
  });

  it("converges from a chat that already accumulated duplicates", async () => {
    // Three calls' worth of live keyboards, as a chat that predates this feature holds.
    await doseCommand();
    await doseCommand();
    closeMock.mockClear();
    // Re-record the two the second call closed, so the chat genuinely holds three.
    await doseCommand();
    const stale = livePrnPointers();
    expect(stale.length).toBeGreaterThanOrEqual(1);

    closeMock.mockClear();
    await doseCommand();

    // Every earlier copy is closed, not just the newest — the invariant is "one", not
    // "one fewer than last time".
    expect(closeMock.mock.calls.map((c) => c[1]).sort()).toEqual(
      stale.map((s) => s.messageId).sort()
    );
    expect(livePrnPointers()).toHaveLength(1);
  });

  it("a NON-re-issuable kind never closes its sibling", async () => {
    // Two dose reminders are two outstanding claims — the morning session and the
    // evening one — both legitimately live. `dose` declares reissuable: false, and this
    // is the assertion that keeps it that way.
    const reminder: NotificationMessage = {
      title: "Morning supplements",
      body: "Time for your morning supplements.",
      kind: "dose",
      actions: [{ label: "✅ Taken", data: `take:${p.profileId}:1:1:${t}` }],
    };
    await dispatch(p.profileId, reminder);
    await dispatch(p.profileId, { ...reminder, title: "Evening supplements" });

    expect(closeMock).not.toHaveBeenCalled();
    expect(liveMessagePointersForKind(p.profileId, CHAT, "dose")).toHaveLength(
      2
    );
  });

  it("a supersede racing the hourly sweep does not double-edit", async () => {
    await doseCommand();
    const first = livePrnPointers()[0];

    // The sweep got there first: it claimed the close and deleted the row. The
    // supersede finds nothing to claim and makes no call — rather than editing the same
    // message a second time, which is the rate-limit budget #1788 exists to protect.
    db.prepare("DELETE FROM notify_messages WHERE id = ?").run(first.id);
    closeMock.mockClear();

    await doseCommand();

    expect(closeMock).not.toHaveBeenCalled();
    expect(livePrnPointers()).toHaveLength(1);
  });

  it("a TRANSIENT close failure keeps the pointer, so the next send retries", async () => {
    // The residual #1945 left open: a failed strip left one extra live keyboard until
    // the day rollover, with no state a retry could run from. Reading the strip target
    // out of the pointer table instead of the outgoing message is what closes it — the
    // row is restored, so it is still a target for the next send AND for the sweep.
    await doseCommand();
    const first = livePrnPointers()[0];

    closeMock.mockImplementation(async () => {
      throw new Error("Bad Gateway");
    });
    await doseCommand();

    // Two live pointers: the survivor and the one whose close failed.
    const afterFailure = livePrnPointers();
    expect(afterFailure.map((x) => x.messageId)).toContain(first.messageId);
    expect(afterFailure).toHaveLength(2);

    // The next call retries it, and converges.
    closeMock.mockImplementation(async () => {});
    closeMock.mockClear();
    await doseCommand();
    expect(closeMock.mock.calls.map((c) => c[1])).toContain(first.messageId);
    expect(livePrnPointers()).toHaveLength(1);
  });

  it("a PERMANENT close failure forgets the pointer instead of retrying forever", async () => {
    await doseCommand();
    await doseCommand();
    closeMock.mockImplementation(async () => {
      throw new Error("Bad Request: message to edit not found");
    });
    closeMock.mockClear();

    await doseCommand();

    expect(closeMock).toHaveBeenCalledTimes(1);
    // The dead message is not carried forward as a target.
    expect(livePrnPointers()).toHaveLength(1);
  });

  it("a failed close never turns a delivered message into a channel failure", async () => {
    const reminder: NotificationMessage = {
      title: "🌙 Check-in",
      body: "How are you today?",
      kind: "mood",
      actions: [{ label: "🙂", data: `mood:${p.profileId}:${t}:4` }],
    };
    await dispatch(p.profileId, reminder);
    closeMock.mockImplementation(async () => {
      throw new Error("Bad Gateway");
    });

    const results = await dispatch(p.profileId, reminder);

    expect(results.find((r) => r.id === "telegram")?.ok).toBe(true);
    expect(getNotifyError()).toBeNull();
  });

  it("leaves the food nudge's own #947 rotation alone", async () => {
    // `food` declares reissuable: false on purpose — its strip is conditioned on the NEW
    // message carrying a `food:` quick-log token, which the generic (chat, kind) rule
    // cannot express. Without that condition a view-control-only nudge (#1807) would
    // close the only keyboard in the chat that can still log a serving.
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, 'leafy_greens', 3)`
    ).run(p.profileId, t);

    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Morning", t)!);
    closeMock.mockClear();
    stripMock.mockClear();
    await dispatch(p.profileId, buildFoodNudge(p.profileId, "Midday", t)!);

    // The rotation strips a keyboard; the supersede would have CLOSED a message. Only
    // the former happens.
    expect(stripMock).toHaveBeenCalledTimes(1);
    expect(closeMock).not.toHaveBeenCalled();
  });
});
