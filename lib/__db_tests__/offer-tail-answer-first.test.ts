// DB INTEGRATION TIER — the digest offer tail's two defects (issue #2418).
//
// Part 1 is an ORDERING fact, and ordering is only observable across two mocked
// network calls, which is why it is pinned here rather than in a pure test: Telegram
// spins the tapped button until `answerCallbackQuery` lands, so an expand/collapse
// that edits first makes the user wait a Bot API round-trip for an outcome that was
// decided the moment the token validated. The assertion is literally "the ack call
// happened before the edit call".
//
// Part 2 is a WRITE fact: a dose logged from the expanded offer list must stamp the
// message it came from (#2264 — an unattributed burst may ride the newest live `dose`
// message, and the digest is not one), and the rebuilt keyboard must carry that tap's
// 🕐 correction chips, which the reminder flow has always had.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageReplyMarkupRaw,
} from "@/lib/notifications/telegram-api";
import { DOSE_TIME_PREFIXES } from "@/lib/notifications/correction-rows";
import { OFFER_COLLAPSE_PREFIX } from "@/lib/notifications/offer-tail";
import { markDoseTaken } from "@/lib/queries/intake/adherence";
import { seedProfile, type SeededProfile, seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

const answerMock = vi.mocked(answerCallbackQuery);
const markupMock = vi.mocked(editMessageReplyMarkupRaw);

const CHAT = "5550418";
const MESSAGE_ID = 4180;

let p: SeededProfile;
let itemId: number;

// The order every mocked Telegram call landed in, so "ack before edit" is an assertion
// rather than a comment.
const calls: string[] = [];

function cq(data: string, keyboard: { callback_data: string }[][]) {
  return {
    id: "cbq-2418",
    data,
    message: {
      message_id: MESSAGE_ID,
      chat: { id: CHAT },
      reply_markup: {
        inline_keyboard: keyboard.map((row) =>
          row.map((b) => ({ text: "x", callback_data: b.callback_data }))
        ),
      },
    },
  };
}

// The digest pointer row this message's taps attribute to.
function seedDigestPointer(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO notify_messages
           (profile_id, chat_id, message_id, kind, date, keyboard, sent_at)
         VALUES (?, ?, ?, 'digest', ?, '[]', datetime('now'))`
      )
      .run(p.profileId, CHAT, MESSAGE_ID, today(p.profileId)).lastInsertRowid
  );
}

beforeAll(() => {
  p = seedProfile("TG2418");
  seedLoginTelegram(p.profileId, CHAT);
  // A `may` supplement with no slot hint — offered in every slot, which is what makes
  // the expansion deterministic whatever hour the suite runs at.
  itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, 'Ibuprofen', 'medication', 1, 'may', 'daily')`
      )
      .run(p.profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', NULL, 'any', 0)`
  ).run(itemId);
});

beforeEach(() => {
  calls.length = 0;
  answerMock.mockClear();
  markupMock.mockClear();
  answerMock.mockImplementation(async () => {
    calls.push("ack");
  });
  markupMock.mockImplementation(async () => {
    calls.push("edit");
    return true as unknown as void;
  });
});

describe("the tap answers first (#2418 part 1)", () => {
  it("acks the offer EXPAND before redrawing the keyboard", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(`offer:${p.profileId}:${date}`, [
        [{ callback_data: `offer:${p.profileId}:${date}` }],
      ])
    );
    expect(calls).toEqual(["ack", "edit"]);
  });

  it("acks the offer COLLAPSE before redrawing the keyboard", async () => {
    const date = today(p.profileId);
    await handleCallbackQuery(
      cq(`${OFFER_COLLAPSE_PREFIX}:${p.profileId}:${date}`, [
        [{ callback_data: `${OFFER_COLLAPSE_PREFIX}:${p.profileId}:${date}` }],
      ])
    );
    expect(calls).toEqual(["ack", "edit"]);
  });

  it("still refuses a tap on YESTERDAY's digest, and edits nothing", async () => {
    await handleCallbackQuery(
      cq(`offer:${p.profileId}:2000-01-01`, [
        [{ callback_data: `offer:${p.profileId}:2000-01-01` }],
      ])
    );
    expect(calls).toEqual(["ack"]);
  });
});

describe("time chips on an offer-logged dose (#2418 part 2)", () => {
  it("stamps the originating message and rebuilds with that tap's correction chips", async () => {
    const pointerId = seedDigestPointer();
    const date = today(p.profileId);
    // The expanded offer list: the item's log button plus the collapse control, which
    // is the durable evidence that this keyboard IS the offer list (the `prn:` prefix
    // alone is shared with /dose).
    await handleCallbackQuery(
      cq(`prn:${p.profileId}:${itemId}:n1`, [
        [{ callback_data: `prn:${p.profileId}:${itemId}:n1` }],
        [
          {
            callback_data: `${OFFER_COLLAPSE_PREFIX}:${p.profileId}:${date}`,
          },
        ],
      ])
    );

    // The administration landed, ATTRIBUTED to this message — without that its burst
    // could ride an unrelated reminder.
    const log = db
      .prepare(
        `SELECT notify_message_id FROM intake_item_logs
          WHERE item_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(itemId) as { notify_message_id: number | null } | undefined;
    expect(log?.notify_message_id).toBe(pointerId);

    // The ack came first, then the redraw — the same ordering rule.
    expect(calls).toEqual(["ack", "edit"]);

    // …and the redrawn keyboard carries the 🕐 chips for that tap.
    // editMessageReplyMarkupRaw(chatId, messageId, keyboard) — the keyboard is the
    // third argument, already the row array.
    const keyboard = (markupMock.mock.calls.at(-1)?.[2] ?? []) as {
      text: string;
      callback_data?: string;
    }[][];
    const tokens = keyboard.flat().map((b) => b.callback_data ?? "");
    expect(tokens.some((t) => t.startsWith(`${DOSE_TIME_PREFIXES.at}:`))).toBe(
      true
    );
    expect(
      tokens.some((t) => t.startsWith(`${DOSE_TIME_PREFIXES.chip}:`))
    ).toBe(true);
  });

  it("leaves a plain /dose message's keyboard alone — no collapse token, no rebuild", async () => {
    await handleCallbackQuery(
      cq(`prn:${p.profileId}:${itemId}:n2`, [
        [{ callback_data: `prn:${p.profileId}:${itemId}:n2` }],
      ])
    );
    expect(calls).toEqual(["ack"]);
  });
});

// ---- render and tap ask the SAME binding question (#3108 follow-up) ---------
//
// The offer list is the one place a DOSE-domain chip rides a message of another
// kind. Its redraw once asked the binding with the HOST's kind (the digest's),
// while the tap handler and the sweep's intake-dose family asked with the DOSE
// domain's — so an UNATTRIBUTED dose burst (an ordinary web one-tap, no forgery
// and no stale keyboard) was rendered here and then refused on touch, breaking
// the invariant stated in lib/notifications/telegram-time-correction.ts: a chat
// can never show a chip the handler would refuse.
//
// Red without the fix: the unattributed burst's chip renders and its tap answers
// the not-bound refusal.
describe("the offer list never shows a chip its own handler refuses (#3108)", () => {
  const NOT_BOUND = "This message can't correct those entries any more";

  function ownDose(): { itemId: number; doseId: number } {
    const item = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
           VALUES (?, 'TG3108 Web Tab', 'medication', 1, 'should', 'daily')`
        )
        .run(p.profileId).lastInsertRowid
    );
    const dose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 tab', 'morning', 'any', 0)`
        )
        .run(item).lastInsertRowid
    );
    return { itemId: item, doseId: dose };
  }

  it("every chip the redraw renders is one the tap handler accepts", async () => {
    // The pointer for this (chat, message) may already stand from an earlier case
    // in this file — one live pointer per delivered message is the invariant, so
    // reuse it rather than inserting a second.
    const existing = db
      .prepare(
        `SELECT id FROM notify_messages WHERE chat_id = ? AND message_id = ?`
      )
      .get(CHAT, MESSAGE_ID) as { id: number } | undefined;
    if (!existing) seedDigestPointer();
    const date = today(p.profileId);

    // A web one-tap: honestly UNATTRIBUTED (no message), and fresh, so it is a
    // burst looking for somewhere to ride.
    const web = ownDose();
    markDoseTaken(p.profileId, web.doseId, web.itemId, date);

    // The user expands the digest's offer list and logs the `may` item from it —
    // that tap IS attributed to the digest, and its chips are what #2443 adds.
    await handleCallbackQuery(
      cq(`prn:${p.profileId}:${itemId}:n3108`, [
        [{ callback_data: `prn:${p.profileId}:${itemId}:n3108` }],
        [{ callback_data: `${OFFER_COLLAPSE_PREFIX}:${p.profileId}:${date}` }],
      ])
    );

    const keyboard = (markupMock.mock.calls.at(-1)?.[2] ?? []) as {
      text: string;
      callback_data?: string;
    }[][];
    const chips = keyboard
      .flat()
      .map((b) => b.callback_data ?? "")
      .filter((t) => t.startsWith(`${DOSE_TIME_PREFIXES.chip}:`));
    // Not vacuous: the tap that just landed still gets its chips.
    expect(chips.length).toBeGreaterThan(0);

    // Every one of them writes when tapped from THIS message — none answers the
    // binding refusal.
    for (const chip of chips) {
      answerMock.mockClear();
      await handleCallbackQuery(cq(chip, [[{ callback_data: chip }]]) as never);
      const answer = answerMock.mock.calls.at(-1)?.[1] ?? "";
      expect(answer, `chip ${chip}`).not.toContain(NOT_BOUND);
    }
  });
});
