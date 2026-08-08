// DB INTEGRATION TIER — the post-workout TYPE ASK over Telegram, end to end (#2272).
//
// The recap composition and the write core are covered next door
// (post-workout-finish.test.ts); what THIS file pins is the pair of things only the
// real chat surface can show:
//
//   1. the keyboard the ask actually puts in the chat — three buttons, one row, each
//      carrying IDS ONLY and bound to the RIGHT activity;
//   2. the tap coming back through handleCallbackQuery: it resolves the acting profile
//      from the chat, writes through the shared core, and answers from the typed
//      outcome — including for a keyboard whose row was absorbed by the duplicate
//      auto-merge (#2271), which must say so rather than confirm a write that did not
//      happen.
//
// Detection SUGGESTS, the user's tap WRITES (#1670). Nothing here classifies on its own.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { seedLoginTelegram } from "./fixtures";

// Stub the one network surface so the real dispatch + render path runs with no I/O.
vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  return {
    ...actual,
    sendMessageRaw: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => {}),
  };
});

import { db, today } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { utcSqlString } from "@/lib/date";
import { runPostWorkoutFinish } from "@/lib/notifications/workout-presence";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  sendMessageRaw,
  answerCallbackQuery,
} from "@/lib/notifications/telegram-api";
import { messageKeyboard } from "@/lib/notifications/telegram-render";

const sendTelegram = vi.mocked(sendMessageRaw);
const answerTap = vi.mocked(answerCallbackQuery);

const NOW = new Date("2026-07-17T18:00:00Z");
const CHAT = "5550942";

function hhmmAgo(minAgo: number): string {
  return new Date(NOW.getTime() - minAgo * 60_000).toISOString().slice(11, 16);
}

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// An imported session that just finished, typed as the caller says.
function seedImportedFinish(profileId: number, type: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities
           (profile_id, date, type, title, start_time, end_time, duration_min,
            avg_hr, created_at, source, external_id)
         VALUES (?, ?, ?, 'Workout', ?, ?, 60, 142, ?, 'health-connect', ?)`
      )
      .run(
        profileId,
        today(profileId),
        type,
        hhmmAgo(80),
        hhmmAgo(20),
        utcSqlString(NOW),
        `health-connect:${type}:${Math.random().toString(36).slice(2)}`
      ).lastInsertRowid
  );
}

// The keyboard rows of the last Telegram send, through the SAME pure grouping the
// wire render uses (`row` keys become side-by-side buttons).
function lastKeyboard(): { text: string; callback_data?: string }[][] {
  const msg = sendTelegram.mock.calls.at(-1)?.[1];
  if (!msg?.actions?.length) return [];
  return messageKeyboard(msg) as { text: string; callback_data?: string }[][];
}

function tap(data: string, chatId = CHAT) {
  return handleCallbackQuery({
    id: "cbq-actype",
    data,
    message: {
      message_id: 4242,
      chat: { id: chatId },
      text: "🏋️ Workout complete",
      reply_markup: { inline_keyboard: lastKeyboard() },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  sendTelegram.mockClear();
  answerTap.mockClear();
  setSetting("telegram_bot_token", "test-bot-token");
});

describe("the type ask's keyboard (#2272)", () => {
  it("puts three id-only buttons on ONE row, bound to the finishing activity", async () => {
    const p = newProfile("AskKeyboard");
    seedLoginTelegram(p, CHAT);
    const activityId = seedImportedFinish(p, "unclassified");

    await runPostWorkoutFinish(p, NOW);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const rows = lastKeyboard();
    expect(rows).toHaveLength(1);
    expect(rows[0].map((b) => b.callback_data)).toEqual([
      `actype:${p}:${activityId}:strength`,
      `actype:${p}:${activityId}:cardio`,
      `actype:${p}:${activityId}:sport`,
    ]);
    // The labels name the three answers a person can give. `unclassified` is the
    // QUESTION, and `recovery` has its own surface — neither is offered.
    expect(rows[0].map((b) => b.text).join(" ")).not.toMatch(
      /unclassified|recovery/i
    );
  });

  it("puts no keyboard on a recap whose source DID state a type", async () => {
    const p = newProfile("AskKeyboardNone");
    seedLoginTelegram(p, CHAT);
    seedImportedFinish(p, "cardio");

    await runPostWorkoutFinish(p, NOW);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    expect(lastKeyboard()).toEqual([]);
  });
});

describe("the tap comes back through the shared core (#2272)", () => {
  it("writes the answer and confirms it", async () => {
    const p = newProfile("AskTap");
    seedLoginTelegram(p, CHAT);
    const activityId = seedImportedFinish(p, "unclassified");
    await runPostWorkoutFinish(p, NOW);

    await tap(`actype:${p}:${activityId}:strength`);
    expect(
      db
        .prepare("SELECT type, edited FROM activities WHERE id = ?")
        .get(activityId)
    ).toEqual({ type: "strength", edited: 1 });
    expect(answerTap.mock.calls.at(-1)?.[1]).toBe("Saved as strength ✅");
  });

  it("answers honestly when the row was absorbed by the duplicate auto-merge", async () => {
    const p = newProfile("AskTapGone");
    seedLoginTelegram(p, CHAT);
    const activityId = seedImportedFinish(p, "unclassified");
    await runPostWorkoutFinish(p, NOW);
    // #2271's sweep collapses the pair and deletes this copy while the keyboard sits
    // in the chat. The tap must not confirm a write that did not happen.
    db.prepare("DELETE FROM activities WHERE id = ?").run(activityId);

    await tap(`actype:${p}:${activityId}:cardio`);
    expect(answerTap.mock.calls.at(-1)?.[1]).toContain("out of date");
  });

  it("refuses a token naming a profile that does not share the chat", async () => {
    const p = newProfile("AskTapOwner");
    const stranger = newProfile("AskTapStranger");
    seedLoginTelegram(p, CHAT);
    const activityId = seedImportedFinish(p, "unclassified");
    await runPostWorkoutFinish(p, NOW);

    await tap(`actype:${stranger}:${activityId}:sport`);
    expect(
      (
        db
          .prepare("SELECT type FROM activities WHERE id = ?")
          .get(activityId) as { type: string }
      ).type
    ).toBe("unclassified");
    expect(answerTap.mock.calls.at(-1)?.[1]).toContain("out of date");
  });
});
