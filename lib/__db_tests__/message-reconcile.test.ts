// DB INTEGRATION TIER (#1779) — tick-time message reconciliation, end to end against
// the real schema, the real senders and the real chokepoint, with ONLY the raw Telegram
// transport stubbed (the #454 guarded boundary).
//
// The harm this pins shut: take a dose, mark it in the app, come back to Telegram hours
// later and the reminder still shows a live "✅ Taken" button, presenting the dose as
// outstanding. That is the safety tier lying in the outbound direction, and it is the
// prompt that invites a double dose.
//
// Every case here goes through a REAL send (so the pointer is recorded exactly as
// production records it) and then through the REAL sweep.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/notifications/telegram-api", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/telegram-api")>();
  let nextMessageId = 1000;
  return {
    ...actual,
    answerCallbackQuery: vi.fn(async () => {}),
    editMessageTextRaw: vi.fn(async () => {}),
    editMessageReplyMarkupRaw: vi.fn(async () => {}),
    sendMessageRaw: vi.fn(async () => nextMessageId++),
  };
});

import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTelegramBotConfig,
  setTimezone,
  setUserBirthdate,
} from "@/lib/settings";
import { markDoseTaken, markDoseSkipped } from "@/lib/queries";
import { dispatch } from "@/lib/notifications";
import { buildIntakeReminderForSlots } from "@/lib/notifications/supplements";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import {
  liveMessagePointers,
  recordMessagePointer,
  parseStoredKeyboard,
  MESSAGE_POINTER_RETENTION_DAYS,
} from "@/lib/notifications/message-pointers";
import { keyboardTokens } from "@/lib/notifications/reconcile-core";
import {
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { buildFoodNudge } from "@/lib/notifications/food";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import { logFoodServingCore } from "@/lib/food-log-write";
import { canonicalFoodGroup } from "@/lib/food-groups";
import { seedLoginTelegram } from "./fixtures";

const editKeyboard = vi.mocked(editMessageReplyMarkupRaw);
const editText = vi.mocked(editMessageTextRaw);

beforeEach(() => {
  // One bot token for the whole file — the channel is only "configured" with one.
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
  editKeyboard.mockClear();
  editText.mockClear();
});

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A daily `must` supplement with one morning dose — the safety-tier shape.
function seedDose(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'supplement', 'daily', 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 cap', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// Send this profile's real morning reminder through the real chokepoint.
async function sendMorningReminder(profileId: number): Promise<void> {
  const built = buildIntakeReminderForSlots(profileId, ["Morning"]);
  expect(
    built,
    "the fixture should have something to remind about"
  ).not.toBeNull();
  await dispatch(profileId, built!.message);
}

// The tokens the pointers for this profile currently carry, flattened.
function liveTokens(profileId: number): string[] {
  return liveMessagePointers(profileId).flatMap((p) =>
    keyboardTokens(p.keyboard)
  );
}

describe("the pointer is recorded for every delivered keyboard (#1779)", () => {
  it("one send to N chats records N pointers — one per delivery", async () => {
    const pid = newProfile("Fanout Fay");
    seedDose(pid, "Fanout D3");
    seedLoginTelegram(pid, "5551779");
    seedLoginTelegram(pid, "5551780");

    await sendMorningReminder(pid);

    const pointers = liveMessagePointers(pid);
    expect(pointers.map((p) => p.chatId).sort()).toEqual([
      "5551779",
      "5551780",
    ]);
    // Each carries the delivered keyboard, not an empty placeholder.
    for (const p of pointers) {
      expect(
        keyboardTokens(p.keyboard).some((t) => t.startsWith("take:"))
      ).toBe(true);
    }
  });

  it("a button-less message records nothing — it can never display a stale claim", async () => {
    const pid = newProfile("Plain Pim");
    seedLoginTelegram(pid, "5551781");
    await dispatch(pid, {
      title: "Note",
      body: "no buttons here",
      kind: "other",
    });
    expect(liveMessagePointers(pid)).toEqual([]);
  });
});

describe("a dose resolved IN THE APP stops being displayed as outstanding", () => {
  it("leaves no live take/skip button for that dose in ANY chat", async () => {
    const pid = newProfile("Double Dora");
    const { itemId, doseId } = seedDose(pid, "Dora D3");
    seedLoginTelegram(pid, "5551782");
    seedLoginTelegram(pid, "5551783");
    await sendMorningReminder(pid);

    // The whole point: the write happens in the APP, nowhere near Telegram.
    expect(markDoseTaken(pid, doseId, itemId, today(pid))).toBe("logged");
    // …and until the tick runs, both chats still claim it is outstanding.
    expect(liveTokens(pid).filter((t) => t.startsWith("take:")).length).toBe(2);

    const out = await reconcileProfileMessages(pid);

    expect(out.closed).toBe(2);
    expect(liveTokens(pid).some((t) => t.includes(`:${doseId}:`))).toBe(false);
    // Both copies were CLOSED, not silently sent again.
    expect(editText).toHaveBeenCalledTimes(2);
  });

  it("a SKIP resolves the claim exactly like a take (#232)", async () => {
    const pid = newProfile("Skip Sasha");
    const { itemId, doseId } = seedDose(pid, "Sasha D3");
    seedLoginTelegram(pid, "5551784");
    await sendMorningReminder(pid);

    markDoseSkipped(pid, doseId, itemId, today(pid));
    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(1);
  });

  it("PARTIAL resolution strips only the resolved buttons and keeps the rest live", async () => {
    const pid = newProfile("Partial Perry");
    const a = seedDose(pid, "Perry A");
    const b = seedDose(pid, "Perry B");
    seedLoginTelegram(pid, "5551785");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    const out = await reconcileProfileMessages(pid);

    expect(out.edited).toBe(1);
    expect(out.closed).toBe(0);
    const tokens = liveTokens(pid);
    // A's buttons are gone; B's survive, because B really is still outstanding.
    expect(tokens.some((t) => t.startsWith(`take:${pid}:${a.doseId}:`))).toBe(
      false
    );
    expect(tokens.some((t) => t.startsWith(`take:${pid}:${b.doseId}:`))).toBe(
      true
    );
  });
});

describe("idempotence — the rate-limit pin", () => {
  it("an UNCHANGED delivery is not edited at all", async () => {
    const pid = newProfile("Quiet Quill");
    seedDose(pid, "Quill D3");
    seedLoginTelegram(pid, "5551786");
    await sendMorningReminder(pid);

    const out = await reconcileProfileMessages(pid);
    expect(out.examined).toBe(1);
    expect(out.edited).toBe(0);
    expect(out.closed).toBe(0);
    expect(editKeyboard).not.toHaveBeenCalled();
    expect(editText).not.toHaveBeenCalled();
  });

  it("a second sweep after a reconcile makes no further calls", async () => {
    const pid = newProfile("Settled Sid");
    const a = seedDose(pid, "Sid A");
    seedDose(pid, "Sid B");
    seedLoginTelegram(pid, "5551787");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    await reconcileProfileMessages(pid);
    editKeyboard.mockClear();
    editText.mockClear();

    const again = await reconcileProfileMessages(pid);
    expect(again.edited).toBe(0);
    expect(editKeyboard).not.toHaveBeenCalled();
    expect(editText).not.toHaveBeenCalled();
  });
});

describe("day rollover", () => {
  it("closes yesterday's still-live keyboard with no next send required", async () => {
    const pid = newProfile("Rollover Rae");
    seedLoginTelegram(pid, "5551788");
    const yd = shiftDateStr(today(pid), -1);
    // A pointer as yesterday's send would have left it.
    recordMessagePointer({
      profileId: pid,
      chatId: "5551788",
      messageId: 4242,
      kind: "dose",
      date: yd,
      keyboard: [
        [{ text: "✅ Taken", callback_data: `take:${pid}:9001:9001:${yd}` }],
      ],
    });

    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(1);
    expect(liveMessagePointers(pid)).toEqual([]);
  });
});

describe("dead pointers and retention", () => {
  it("an edit that fails drops the pointer instead of retrying forever", async () => {
    const pid = newProfile("Ghost Gil");
    const { itemId, doseId } = seedDose(pid, "Gil D3");
    seedLoginTelegram(pid, "5551789");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid));

    // Telegram's answer for a message that no longer exists.
    editText.mockRejectedValueOnce(
      new Error("Telegram editMessageText failed: message to edit not found")
    );
    const out = await reconcileProfileMessages(pid);
    expect(out.dropped).toBe(1);
    expect(liveMessagePointers(pid)).toEqual([]);
  });

  it("pointers past Telegram's edit horizon are pruned", async () => {
    const pid = newProfile("Old Ozzy");
    seedLoginTelegram(pid, "5551790");
    recordMessagePointer({
      profileId: pid,
      chatId: "5551790",
      messageId: 77,
      kind: "dose",
      date: today(pid),
      keyboard: [
        [{ text: "x", callback_data: `take:${pid}:1:1:${today(pid)}` }],
      ],
    });
    db.prepare(
      `UPDATE notify_messages
          SET sent_at = datetime('now', ?)
        WHERE profile_id = ?`
    ).run(`-${MESSAGE_POINTER_RETENTION_DAYS + 1} days`, pid);

    const out = await reconcileProfileMessages(pid);
    expect(out.pruned).toBe(1);
    expect(out.examined).toBe(0);
  });

  it("a corrupt keyboard blob is skipped, never thrown on", async () => {
    const pid = newProfile("Corrupt Cass");
    seedLoginTelegram(pid, "5551791");
    db.prepare(
      `INSERT INTO notify_messages
         (profile_id, chat_id, message_id, kind, date, keyboard, sent_at)
       VALUES (?, '5551791', 5, 'dose', ?, 'not json', datetime('now'))`
    ).run(pid, today(pid));

    expect(parseStoredKeyboard("not json")).toBeNull();
    const out = await reconcileProfileMessages(pid);
    expect(out.examined).toBe(0);
  });
});

describe("scope", () => {
  it("one profile's sweep never touches another profile's messages", async () => {
    const mine = newProfile("Mine Mina");
    const theirs = newProfile("Theirs Theo");
    const m = seedDose(mine, "Mina D3");
    seedDose(theirs, "Theo D3");
    seedLoginTelegram(mine, "5551792");
    seedLoginTelegram(theirs, "5551793");
    await sendMorningReminder(mine);
    await sendMorningReminder(theirs);

    markDoseTaken(mine, m.doseId, m.itemId, today(mine));
    await reconcileProfileMessages(mine);

    expect(liveMessagePointers(mine)).toEqual([]);
    expect(liveMessagePointers(theirs)).toHaveLength(1);
  });
});

// ── The other button classes ────────────────────────────────────────────────
//
// These record the pointer directly rather than driving each family's full send. The
// recording path itself is already pinned above by real sends; what these isolate is
// the per-family RESOLUTION PREDICATE — which is the part that has to agree with the
// ledger, and the part a future change could break.

describe("class 1 — the other state-claim families", () => {
  it("a missed-dose ESCALATION stops claiming a dose was missed once it is confirmed", async () => {
    const pid = newProfile("Escalate Elle");
    const { itemId, doseId } = seedDose(pid, "Elle Med");
    seedLoginTelegram(pid, "5551794");
    const td = today(pid);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551794",
      messageId: 501,
      kind: "escalation",
      date: td,
      keyboard: [
        [
          {
            text: "✅ Confirmed",
            callback_data: `esctake:${pid}:${doseId}:${itemId}:${td}`,
          },
          {
            text: "⏭ Skipped",
            callback_data: `escskip:${pid}:${doseId}:${itemId}:${td}`,
          },
        ],
        [
          {
            text: "👍 On it",
            callback_data: `escack:${pid}:${doseId}:${itemId}:${td}`,
          },
        ],
      ],
    });

    // Unresolved: the caregiver's chat is telling the truth, so nothing is touched.
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    markDoseTaken(pid, doseId, itemId, td);
    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(1);
  });

  it("a HOUSEHOLD ROUND resolves member by member — the canonical partial case", async () => {
    const carer = newProfile("Carer Cleo");
    const wardA = newProfile("Ward Ana");
    const wardB = newProfile("Ward Bo");
    const a = seedDose(wardA, "Ana Med");
    const b = seedDose(wardB, "Bo Med");
    seedLoginTelegram(carer, "5551795");
    const td = today(carer);
    recordMessagePointer({
      profileId: carer,
      chatId: "5551795",
      messageId: 502,
      kind: "dose",
      date: td,
      keyboard: [
        [
          {
            text: "✓ Ana",
            callback_data: `hh:${carer}:${wardA}:${a.doseId}:${a.itemId}:${td}`,
          },
        ],
        [
          {
            text: "✓ Bo",
            callback_data: `hh:${carer}:${wardB}:${b.doseId}:${b.itemId}:${td}`,
          },
        ],
      ],
    });

    // Ana's dose is confirmed in the app; Bo's is not.
    markDoseTaken(wardA, a.doseId, a.itemId, td);
    const out = await reconcileProfileMessages(carer);
    expect(out.edited).toBe(1);
    expect(out.closed).toBe(0);

    const tokens = liveTokens(carer);
    expect(tokens.some((t) => t.includes(`:${wardA}:`))).toBe(false);
    expect(tokens.some((t) => t.includes(`:${wardB}:`))).toBe(true);
  });

  it("a daily CHECK-IN closes once the day's mood is logged anywhere", async () => {
    const pid = newProfile("Mood Mo");
    seedLoginTelegram(pid, "5551796");
    const td = today(pid);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551796",
      messageId: 503,
      kind: "mood",
      date: td,
      keyboard: [
        [
          { text: "🙂", callback_data: `mood:${pid}:4:${td}` },
          { text: "😐", callback_data: `mood:${pid}:3:${td}` },
        ],
      ],
    });
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    db.prepare(
      `INSERT INTO mood_logs (profile_id, date, valence, energy) VALUES (?, ?, 4, 3)`
    ).run(pid, td);
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
  });
});

describe("class 3 — decision buttons", () => {
  it("a demotion ACCEPTED in the app closes the suggestion on the next tick", async () => {
    const pid = newProfile("Demote Dev");
    const { itemId } = seedDose(pid, "Dev D3");
    seedLoginTelegram(pid, "5551797");
    const td = today(pid);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551797",
      messageId: 504,
      kind: "dose",
      date: td,
      keyboard: [
        [{ text: "⤓ May", callback_data: `demote:${pid}:${itemId}:${td}` }],
      ],
    });
    // Still `must`: the offer is real, so nothing is touched.
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    // The user accepts the demotion in the app.
    db.prepare(
      `UPDATE intake_items SET obligation = 'may' WHERE id = ? AND profile_id = ?`
    ).run(itemId, pid);
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
  });
});

describe("class 2 — additive quick-log buttons", () => {
  it("an in-app food log rebuilds the nudge's counts; an unchanged day does not", async () => {
    const pid = newProfile("Food Fern");
    // An adult profile, so the food nudge is relevant at all. A DEEP-PAST birthdate,
    // never a fixed near-present one.
    setUserBirthdate(pid, "1970-04-02");
    seedLoginTelegram(pid, "5551798");
    const td = today(pid);

    const nudge = buildFoodNudge(pid, "Morning", td);
    expect(nudge, "the fixture profile should get a food nudge").not.toBeNull();
    recordMessagePointer({
      profileId: pid,
      chatId: "5551798",
      messageId: 505,
      kind: "food",
      date: td,
      keyboard: messageKeyboard(nudge!),
    });

    // Nothing logged since the send: the counts on the buttons are still correct.
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);
    expect(editText).not.toHaveBeenCalled();

    // A serving logged IN THE APP changes the "(n)" the buttons carry.
    const slug = canonicalFoodGroup("leafy greens");
    expect(slug).not.toBeNull();
    // Explicit meal slot, so the serving lands in the window the nudge is scoped to
    // rather than wherever the run clock happens to fall.
    logFoodServingCore(pid, slug!, td, new Date().toISOString(), "Morning");

    const out = await reconcileProfileMessages(pid);
    expect(out.edited).toBe(1);
    expect(out.closed).toBe(0);
    // The keyboard stays LIVE — logging another serving is still valid all day.
    expect(liveTokens(pid).some((t) => t.startsWith("food:"))).toBe(true);
  });
});
