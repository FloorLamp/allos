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
import { dispatch, prefixForProfile } from "@/lib/notifications";
import { prefixMessage } from "@/lib/notifications/types";
import { buildIntakeReminderForSlots } from "@/lib/notifications/supplements";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import {
  claimMessagePointerClose,
  claimMessagePointerKeyboard,
  liveMessagePointers,
  recordMessagePointer,
  parseStoredKeyboard,
  MESSAGE_POINTER_RETENTION_DAYS,
} from "@/lib/notifications/message-pointers";
import {
  keyboardTokens,
  RECONCILE_CLOSING,
} from "@/lib/notifications/reconcile-core";
import {
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { TelegramApiError } from "@/lib/notifications/telegram-error";
import { buildFoodNudge } from "@/lib/notifications/food";
import { countVisibleFoodButtons } from "@/lib/notifications/food-format";
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

// The profile's single live keyboard — what the chat is showing, as the pointer records it.
function liveKeyboard(profileId: number) {
  const pointers = liveMessagePointers(profileId);
  expect(pointers).toHaveLength(1);
  return pointers[0].keyboard;
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

// ── A failed edit is CLASSIFIED, not assumed dead (#1885) ───────────────────
//
// The sweep claims a pointer BEFORE it calls Telegram, so dropping it on any thrown
// error at all was unrecoverable by construction: a 429, a 5xx or a network blip
// permanently forgot the only record of what a live chat is showing, and the stale
// keyboard stood forever. Only the permanently-dead answers may forget the pointer;
// a transient one has to leave the next tick something to retry from.
describe("a TRANSIENT edit failure keeps the pointer retryable (#1885)", () => {
  // A 5xx as the typed transport throws it.
  function transientFailure(method = "editMessageText"): TelegramApiError {
    return new TelegramApiError({
      method,
      status: 502,
      description: null,
      message: `Telegram ${method} failed: HTTP 502`,
    });
  }

  it("a failed CLOSE is retried by the next pass, not forgotten", async () => {
    const pid = newProfile("Blip Bella");
    const { itemId, doseId } = seedDose(pid, "Bella D3");
    seedLoginTelegram(pid, "5551885");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid));
    const before = liveMessagePointers(pid)[0];

    editText.mockRejectedValueOnce(transientFailure());
    const first = await reconcileProfileMessages(pid);

    expect(first.deferred).toBe(1);
    expect(first.dropped).toBe(0);
    expect(first.closed).toBe(0);
    // The close CLAIM deleted the row before the call; the release put it back exactly
    // as it was — same row, same witness — which is what makes a retry possible at all.
    const kept = liveMessagePointers(pid);
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(before.id);
    expect(kept[0].messageId).toBe(before.messageId);
    expect(kept[0].version).toBe(before.version);
    expect(kept[0].sentAt).toBe(before.sentAt);

    // The next tick, with Telegram answering again.
    const second = await reconcileProfileMessages(pid);
    expect(second.closed).toBe(1);
    expect(second.deferred).toBe(0);
    expect(liveMessagePointers(pid)).toEqual([]);
    // Two attempts at the same close — the failed one and the successful retry.
    expect(editText).toHaveBeenCalledTimes(2);
  });

  it("a failed STRIP leaves the pointer describing what the chat still shows", async () => {
    const pid = newProfile("Blip Bruno");
    const a = seedDose(pid, "Bruno A");
    seedDose(pid, "Bruno B");
    seedLoginTelegram(pid, "5551886");
    await sendMorningReminder(pid);
    markDoseTaken(pid, a.doseId, a.itemId, today(pid));

    editText.mockRejectedValueOnce(transientFailure());
    const first = await reconcileProfileMessages(pid);
    expect(first.deferred).toBe(1);
    expect(first.edited).toBe(0);

    // The edit never landed, so the chat is still showing A's button — and the pointer
    // says so. A pointer left holding the POST-edit keyboard would be lying about the
    // chat and would never plan the strip again.
    expect(
      liveTokens(pid).some((t) => t.startsWith(`take:${pid}:${a.doseId}:`))
    ).toBe(true);

    const second = await reconcileProfileMessages(pid);
    expect(second.edited).toBe(1);
    expect(
      liveTokens(pid).some((t) => t.startsWith(`take:${pid}:${a.doseId}:`))
    ).toBe(false);
  });

  it("a rate limit is transient, not a dead message", async () => {
    const pid = newProfile("Limit Lina");
    const { itemId, doseId } = seedDose(pid, "Lina D3");
    seedLoginTelegram(pid, "5551887");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid));

    editText.mockRejectedValueOnce(
      new TelegramApiError({
        method: "editMessageText",
        status: 429,
        description: "Too Many Requests: retry after 30",
        message:
          "Telegram editMessageText failed: Too Many Requests: retry after 30",
      })
    );
    const out = await reconcileProfileMessages(pid);
    expect(out.deferred).toBe(1);
    expect(out.dropped).toBe(0);
    expect(liveMessagePointers(pid)).toHaveLength(1);
  });

  it("a chat the bot was blocked from IS dead — the permanent path still drops", async () => {
    const pid = newProfile("Blocked Bo");
    const { itemId, doseId } = seedDose(pid, "Bo D3");
    seedLoginTelegram(pid, "5551888");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid));

    editText.mockRejectedValueOnce(
      new TelegramApiError({
        method: "editMessageText",
        status: 403,
        description: "Forbidden: bot was blocked by the user",
        message:
          "Telegram editMessageText failed: Forbidden: bot was blocked by the user",
      })
    );
    const out = await reconcileProfileMessages(pid);
    expect(out.dropped).toBe(1);
    expect(out.deferred).toBe(0);
    expect(liveMessagePointers(pid)).toEqual([]);
  });

  it("retries stay bounded by retention — a permanently failing pointer ages out", async () => {
    // The bound that lets "transient" mean retry without meaning retry FOREVER: the
    // restored row keeps its original sent_at, so the pruner still reaches it.
    const pid = newProfile("Bounded Bea");
    const { itemId, doseId } = seedDose(pid, "Bea D3");
    seedLoginTelegram(pid, "5551889");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid));

    editText.mockRejectedValueOnce(transientFailure());
    expect((await reconcileProfileMessages(pid)).deferred).toBe(1);

    db.prepare(
      `UPDATE notify_messages SET sent_at = datetime('now', ?) WHERE profile_id = ?`
    ).run(`-${MESSAGE_POINTER_RETENTION_DAYS + 1} days`, pid);
    const out = await reconcileProfileMessages(pid);
    expect(out.pruned).toBe(1);
    expect(out.examined).toBe(0);
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

  // #1807. The re-render is the ONLY reconciler that rebuilds a whole message, so it is
  // the only one that can change what the user chose to see. Expansion is the user's:
  // the rebuild reads its visible count off the pointer's live keyboard, exactly as the
  // tap handlers do, so a tick can neither collapse a keyboard someone expanded nor
  // re-expand one they collapsed.
  it("a rebuild preserves the expansion the user set, rather than resetting to the default", async () => {
    const pid = newProfile("Expand Esme");
    setUserBirthdate(pid, "1970-04-02");
    seedLoginTelegram(pid, "5551807");
    const td = today(pid);

    // The chat is showing an EXPANDED keyboard (the state a "Show more" tap leaves).
    const expanded = buildFoodNudge(pid, "Morning", td, 12);
    expect(expanded).not.toBeNull();
    const sentKeyboard = messageKeyboard(expanded!);
    expect(countVisibleFoodButtons(sentKeyboard)).toBe(12);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551807",
      messageId: 506,
      kind: "food",
      date: td,
      keyboard: sentKeyboard,
    });

    // Nothing has changed, so the sweep must not touch it at all — a rebuild at the
    // compact default would differ from the delivered keyboard and spend an edit.
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    // Now something the counts DO depend on changes, forcing a real re-render.
    const slug = canonicalFoodGroup("leafy greens");
    expect(slug).not.toBeNull();
    logFoodServingCore(pid, slug!, td, new Date().toISOString(), "Morning");
    expect((await reconcileProfileMessages(pid)).edited).toBe(1);

    // The re-render kept the 12-button expansion, and the pointer records it.
    expect(countVisibleFoodButtons(liveKeyboard(pid))).toBe(12);
  });
});

// ── Overlapping ticks (#1788) ───────────────────────────────────────────────
//
// The repo already documents the overlap risk class for the SEND path (scripts/notify.ts:
// "operators should run exactly ONE tick scheduler"). The reconcile sweep inherits it: a
// compose poll sidecar plus a host crontab, two app instances on one volume, or a manual
// `notify` run during the hourly one all put two passes on one profile at once. Both
// would read the same pre-edit keyboard and both call the Bot API for an identical
// result — converging, so nothing is corrupted, but spending twice the rate-limit budget
// the sweep's zero-call steady state exists to protect.
//
// The pointer's keyboard is therefore a lifecycle field with an atomic transition: a
// pass CLAIMS old-blob → new-blob before it touches the network, and only the winner
// calls Telegram.

describe("concurrent reconcile passes edit each message exactly once", () => {
  it("two overlapping sweeps close two messages with two calls, not four", async () => {
    const pid = newProfile("Race Rita");
    const { itemId, doseId } = seedDose(pid, "Rita D3");
    // TWO chats, so the passes genuinely interleave: the second claims the pointer the
    // first has not reached yet, and the first then finds its own witness stale.
    seedLoginTelegram(pid, "5551801");
    seedLoginTelegram(pid, "5551802");
    await sendMorningReminder(pid);
    expect(liveMessagePointers(pid)).toHaveLength(2);

    markDoseTaken(pid, doseId, itemId, today(pid));

    const [a, b] = await Promise.all([
      reconcileProfileMessages(pid),
      reconcileProfileMessages(pid),
    ]);

    // Each message is closed once — never twice.
    expect(a.closed + b.closed).toBe(2);
    expect(editText).toHaveBeenCalledTimes(2);
    // And the duplicate work was refused rather than performed.
    expect(a.skipped + b.skipped).toBeGreaterThan(0);
    expect(liveMessagePointers(pid)).toEqual([]);
  });

  it("a strip is claimed once, so the second pass makes no call", async () => {
    const pid = newProfile("Race Reza");
    const a = seedDose(pid, "Reza A");
    seedDose(pid, "Reza B");
    seedLoginTelegram(pid, "5551803");
    seedLoginTelegram(pid, "5551804");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    const [x, y] = await Promise.all([
      reconcileProfileMessages(pid),
      reconcileProfileMessages(pid),
    ]);

    // Two deliveries, two rebuilds — not four.
    expect(x.edited + y.edited).toBe(2);
    expect(editText).toHaveBeenCalledTimes(2);
  });
});

describe("the pointer claim is a compare-and-swap (#1788)", () => {
  function onePointer(profileId: number) {
    const [p] = liveMessagePointers(profileId);
    expect(p, "fixture should have recorded a pointer").toBeDefined();
    return p;
  }

  it("the witness READ from the store is one the claim accepts", async () => {
    // The regression this pins: the witness is the stored blob VERBATIM, never a
    // re-serialization. A round-trip that reordered a key would produce a witness that
    // never matches — and the sweep would silently stop editing anything, forever.
    const pid = newProfile("Witness Wren");
    seedDose(pid, "Wren D3");
    seedLoginTelegram(pid, "5551805");
    await sendMorningReminder(pid);

    const p = onePointer(pid);
    expect(claimMessagePointerKeyboard(pid, p.id, p.version, [])).toBe(true);
  });

  it("two passes holding the SAME witness — exactly one wins", async () => {
    const pid = newProfile("Swap Sven");
    seedDose(pid, "Sven D3");
    seedLoginTelegram(pid, "5551806");
    await sendMorningReminder(pid);

    // Both processes read before either wrote: the cross-process shape, which no amount
    // of in-process ordering can prevent.
    const p = onePointer(pid);
    const first = claimMessagePointerKeyboard(pid, p.id, p.version, [
      [{ text: "a", callback_data: "x:1" }],
    ]);
    const second = claimMessagePointerKeyboard(pid, p.id, p.version, [
      [{ text: "b", callback_data: "x:2" }],
    ]);
    expect([first, second]).toEqual([true, false]);
    // The winner's keyboard stands; the loser overwrote nothing.
    expect(onePointer(pid).keyboard[0][0].text).toBe("a");
  });

  it("closing is claimed the same way — a message cannot be closed twice", async () => {
    const pid = newProfile("Close Coby");
    seedDose(pid, "Coby D3");
    seedLoginTelegram(pid, "5551807");
    await sendMorningReminder(pid);

    const p = onePointer(pid);
    expect(claimMessagePointerClose(pid, p.id, p.version)).toBe(true);
    expect(claimMessagePointerClose(pid, p.id, p.version)).toBe(false);
    expect(liveMessagePointers(pid)).toEqual([]);
  });

  it("a claim never reaches another profile's pointer", async () => {
    const mine = newProfile("Mine Mabel");
    const theirs = newProfile("Theirs Tarek");
    seedDose(theirs, "Tarek D3");
    seedLoginTelegram(theirs, "5551808");
    await sendMorningReminder(theirs);

    const p = onePointer(theirs);
    expect(claimMessagePointerClose(mine, p.id, p.version)).toBe(false);
    expect(liveMessagePointers(theirs)).toHaveLength(1);
  });
});

// ---- The close NAMES ITS SUBJECT (issue #1822 item 7) ----
//
// A close replaces the ENTIRE message text, so the reader used to get an orphan bubble at
// 08:00 — "Handled in the app — nothing left here." with no indication of WHAT was handled
// — and in a shared family chat the "[Name] " attribution went with the rest of the text,
// so two members' identical reminders became indistinguishable once resolved. The pointer
// now records the delivered title, and the sweep composes the close from it.
describe("a closed message says what it closed (#1822 item 7)", () => {
  // The attribution the TICK applies at the send site (scripts/notify.ts), reproduced here
  // so the pointer stores exactly the title a real multi-profile send delivers.
  async function sendAttributedReminder(profileId: number): Promise<string> {
    const built = buildIntakeReminderForSlots(profileId, ["Morning"]);
    expect(built).not.toBeNull();
    const msg = prefixMessage(built!.message, prefixForProfile(profileId));
    await dispatch(profileId, msg);
    return msg.title;
  }

  it("closes with the attributed title, not a subjectless sentence", async () => {
    const pid = newProfile("Norton");
    const { itemId, doseId } = seedDose(pid, "Norton D3");
    seedLoginTelegram(pid, "5551990");
    const title = await sendAttributedReminder(pid);
    // The instance has several profiles by now, so the send really is attributed.
    expect(title).toContain("[Norton]");
    // The pointer remembered it, which is what makes the close possible at all.
    expect(liveMessagePointers(pid)[0]?.title).toBe(title);

    expect(markDoseTaken(pid, doseId, itemId, today(pid))).toBe("logged");
    const out = await reconcileProfileMessages(pid);

    expect(out.closed).toBe(1);
    const closingText = editText.mock.calls.at(-1)![2];
    expect(closingText).toBe(`${title} — handled in the app.`);
    expect(closingText).toContain("[Norton]");
  });

  it("keeps two members' closes distinguishable in one shared chat", async () => {
    const shared = "5551991";
    const a = newProfile("Ada");
    const b = newProfile("Ben");
    const ad = seedDose(a, "Ada D3");
    const bd = seedDose(b, "Ben D3");
    seedLoginTelegram(a, shared);
    seedLoginTelegram(b, shared);
    await sendAttributedReminder(a);
    await sendAttributedReminder(b);

    markDoseTaken(a, ad.doseId, ad.itemId, today(a));
    markDoseTaken(b, bd.doseId, bd.itemId, today(b));
    editText.mockClear();
    await reconcileProfileMessages(a);
    await reconcileProfileMessages(b);

    const texts = editText.mock.calls.map((c) => String(c[2]));
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toBe(texts[1]);
    expect(texts.some((t) => t.includes("[Ada]"))).toBe(true);
    expect(texts.some((t) => t.includes("[Ben]"))).toBe(true);
  });

  it("names the subject on a ROLLOVER close too", async () => {
    const pid = newProfile("Rollover Rhea");
    seedLoginTelegram(pid, "5551992");
    const yd = shiftDateStr(today(pid), -1);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551992",
      messageId: 4343,
      kind: "food",
      date: yd,
      keyboard: [
        [
          {
            text: "🥬 Leafy greens",
            callback_data: `food:${pid}:Morning:${yd}:leafy_greens`,
          },
        ],
      ],
      title: "[Rhea] 🍽️ Morning food log",
    });

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(editText.mock.calls.at(-1)![2]).toBe(
      "[Rhea] 🍽️ Morning food log — this was yesterday's message."
    );
  });

  it("degrades to the bare line for a pointer with no recorded title", async () => {
    // A pointer written before migration 139 — nothing to name, so nothing is invented.
    const pid = newProfile("Legacy Lou");
    seedLoginTelegram(pid, "5551993");
    const yd = shiftDateStr(today(pid), -1);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551993",
      messageId: 4444,
      kind: "dose",
      date: yd,
      keyboard: [
        [{ text: "✅ Taken", callback_data: `take:${pid}:9002:9002:${yd}` }],
      ],
    });

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(editText.mock.calls.at(-1)![2]).toBe(RECONCILE_CLOSING.rollover);
  });
});
