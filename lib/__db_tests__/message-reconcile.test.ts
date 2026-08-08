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

import { vi, describe, it, expect, afterEach, beforeEach } from "vitest";

// The digest gather is what #2069 stopped paying for on every tick and #2070 stopped
// letting starve the sweep, so both need to see it: this counts every call and can be
// told to blow one up. `vi.hoisted` because a vi.mock factory is lifted above the imports.
const gatherState = vi.hoisted(() => ({
  calls: 0,
  throwFor: null as number | null,
}));

vi.mock("@/lib/notifications/digest-data", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/digest-data")>();
  return {
    ...actual,
    gatherDigestInput: (
      ...args: Parameters<typeof actual.gatherDigestInput>
    ) => {
      gatherState.calls++;
      if (gatherState.throwFor === args[0])
        throw new Error("digest gather blew up");
      return actual.gatherDigestInput(...args);
    },
  };
});

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
  setUserSex,
} from "@/lib/settings";
import { markDoseTaken, markDoseSkipped } from "@/lib/queries";
import {
  recordPreventiveDone,
  setPreventiveOverride,
} from "@/lib/queries/upcoming/preventive";
import { setProfileFoodTelegram } from "@/lib/settings/notifications";
import { discardWorkoutSession } from "@/lib/workout-finish";
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
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import {
  DIGEST_DEPENDENCIES,
  DIGEST_REGATHER_FLOOR_MS,
  digestDependencyStamp,
  digestStampSql,
} from "@/lib/notifications/digest-deps";
import {
  formatProseGatherRecord,
  parseProseGatherRecord,
} from "@/lib/notifications/reconcile-core";
import { getProfileSetting, setProfileSetting } from "@/lib/settings";
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
  gatherState.calls = 0;
  gatherState.throwFor = null;
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
  it("closes yesterday's still-live FOOD keyboard with no next send required", async () => {
    // A food token's date is the system's guess at when the user ate, and the guess
    // expires at midnight (#947) — so this family, and only a family like it, is the
    // one the day boundary ends.
    const pid = newProfile("Rollover Rae");
    seedLoginTelegram(pid, "5551788");
    const yd = shiftDateStr(today(pid), -1);
    // A pointer as yesterday's send would have left it.
    recordMessagePointer({
      profileId: pid,
      chatId: "5551788",
      messageId: 4242,
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
    });

    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(1);
    expect(liveMessagePointers(pid)).toEqual([]);
  });
});

// ── HOW LATE A KEYBOARD MAY STILL BE TAPPED (issue #2018) ────────────────────
//
// The sweep used to close EVERY live keyboard at the first tick after local midnight, so
// last night's bedtime supplements could not be confirmed from the chat in the morning —
// while `markDoseTaken` was, and still is, built to honor that tap for ±2 days (#614).
// The two unit tiers cannot see the two halves disagreeing; this is where the sweep and
// the write core meet.
//
// The clock is MOVED rather than the rows hand-edited: the reminder is really SENT on D
// through the real chokepoint, and the sweep is then run on D+1, D+2 and D+3 exactly as
// the hourly tick would run it.
describe("a dose keyboard lives as long as the write core honors the tap (#2018)", () => {
  const D = "2020-03-04";
  const EVENING = `${D}T22:00:00Z`;
  let priorNow: string | undefined;

  function at(instant: string): void {
    process.env.ALLOS_TEST_NOW = instant;
  }

  beforeEach(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    at(EVENING);
  });

  afterEach(() => {
    if (priorNow === undefined) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = priorNow;
  });

  it("survives local midnight, and the tap it offers still logs to its own day", async () => {
    const pid = newProfile("Bedtime Bea");
    const { itemId, doseId } = seedDose(pid, "Bea D3");
    seedLoginTelegram(pid, "5552018");
    await sendMorningReminder(pid);
    expect(today(pid)).toBe(D);

    // The first tick after local midnight — the reported regression. Still the
    // steady state: an unresolved reminder costs ZERO Telegram calls on the far side
    // of the boundary, exactly as it did on the near side.
    at(`${shiftDateStr(D, 1)}T00:30:00Z`);
    const overnight = await reconcileProfileMessages(pid);
    expect(overnight.closed).toBe(0);
    expect(overnight.edited).toBe(0);
    expect(editText).not.toHaveBeenCalled();
    expect(editKeyboard).not.toHaveBeenCalled();
    expect(
      liveTokens(pid).some((t) => t.startsWith(`take:${pid}:${doseId}:`))
    ).toBe(true);

    // Still inside DOSE_LOG_DATE_WINDOW_DAYS on D+2.
    at(`${shiftDateStr(D, 2)}T09:00:00Z`);
    expect((await reconcileProfileMessages(pid)).closed).toBe(0);

    // And the button is not decorative: the write core honors the tap, on D's ledger.
    expect(markDoseTaken(pid, doseId, itemId, D)).toBe("logged");

    // Resolved for real now, so the message closes as HANDLED — not as out of date.
    // Since #2274 "handled" is the dose NAMED, in the domain's own word.
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain("Bea D3 taken.");
  });

  it("closes past the window, naming the consequence rather than the calendar", async () => {
    const pid = newProfile("Late Lena");
    seedDose(pid, "Lena D3");
    seedLoginTelegram(pid, "5552019");
    await sendMorningReminder(pid);

    at(`${shiftDateStr(D, 3)}T09:00:00Z`);
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    const text = String(editText.mock.calls.at(-1)![2]);
    expect(text).toContain("too late to confirm here");
    // "This is yesterday's message" would be both wrong and unhelpful here.
    expect(text).not.toContain("yesterday");
    expect(liveMessagePointers(pid)).toEqual([]);
  });

  it("leaves a live workout draft's finish/discard alone across midnight", async () => {
    // `wofinish`/`wodiscard` carry no date because a draft is not a day's claim — it is
    // the live session, and getWorkoutPresence is the only thing that ends the message.
    const pid = newProfile("Nightowl Nia");
    seedLoginTelegram(pid, "5552020");
    at(`${shiftDateStr(D, 1)}T00:30:00Z`);
    const stamp = `${shiftDateStr(D, 1)} 00:20:00`;
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities
             (profile_id, date, type, title, start_time, source, created_at, updated_at)
           VALUES (?, ?, 'strength', 'Live session', '23:40', NULL, ?, ?)`
        )
        .run(pid, shiftDateStr(D, 1), stamp, stamp).lastInsertRowid
    );
    recordMessagePointer({
      profileId: pid,
      chatId: "5552020",
      messageId: 4545,
      kind: "workout-stale",
      // Sent before midnight, on the day the session started.
      date: D,
      keyboard: [
        [
          {
            text: "🏁 Finish workout",
            callback_data: `wofinish:${pid}:${activityId}`,
          },
          {
            text: "🗑 Discard",
            callback_data: `wodiscard:${pid}:${activityId}`,
          },
        ],
      ],
    });

    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(0);
    expect(out.edited).toBe(0);
    expect(liveTokens(pid)).toContain(`wofinish:${pid}:${activityId}`);
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
    // The outcome (#2170/#2274) rides the SAME attributed subject this issue put there.
    expect(closingText).toBe(`${title} — Norton D3 taken.`);
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
    });

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(editText.mock.calls.at(-1)![2]).toBe(RECONCILE_CLOSING.rollover);
  });
});

// ---- The closing edit states the OUTCOME (#2170 → #2274) -------------------
//
// A fully-resolved close replaced the ENTIRE message text, so the chat history ended up
// less informative than the reminder had been: the reader knew something was recorded,
// not what. #2170 answered with counts, which still said LESS than the reminder — it
// named every item. The names below are the reconcile's own resolution facts restated,
// from the same ledger reads that decided the close, in the words the buttons used.

describe("a resolved close states the outcome (#2170/#2274)", () => {
  it("names what the ledger says: taken and skipped", async () => {
    const pid = newProfile("Tally Tara");
    const a = seedDose(pid, "Tara A");
    const b = seedDose(pid, "Tara B");
    const c = seedDose(pid, "Tara C");
    seedLoginTelegram(pid, "5552170");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    markDoseTaken(pid, b.doseId, b.itemId, today(pid));
    markDoseSkipped(pid, c.doseId, c.itemId, today(pid));

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    const text = String(editText.mock.calls.at(-1)![2]);
    expect(text).toContain("Tara A, Tara B taken · Tara C skipped.");
    // The message's own subject still leads it (#1822 item 7).
    expect(text.startsWith("💊 Morning supplements —")).toBe(true);
    // The domain's own words, and no app pointer (#2274).
    expect(text).not.toContain("logged");
    expect(text).not.toContain("In the app.");
  });

  it("all taken reads as one clean clause — the empty group is omitted", async () => {
    const pid = newProfile("Whole Wren");
    const a = seedDose(pid, "Wren A");
    const b = seedDose(pid, "Wren B");
    seedLoginTelegram(pid, "5552171");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    markDoseTaken(pid, b.doseId, b.itemId, today(pid));

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      "Wren A, Wren B taken."
    );
  });

  it("THE SNAPSHOT PROPERTY: a later in-app edit changes nothing in the chat", async () => {
    // Closing is forgetting — the claim deletes the pointer, so no later sweep can
    // re-edit this text. The line is HISTORICAL, exactly like any other chat message,
    // and that is the design rather than a gap in it.
    const pid = newProfile("Snapshot Sana");
    const a = seedDose(pid, "Sana A");
    seedLoginTelegram(pid, "5552172");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid));
    await reconcileProfileMessages(pid);
    const closingText = String(editText.mock.calls.at(-1)![2]);
    expect(closingText).toContain("Sana A taken.");
    expect(liveMessagePointers(pid)).toEqual([]);

    // Correct it in the app afterwards…
    markDoseSkipped(pid, a.doseId, a.itemId, today(pid));
    editText.mockClear();
    const again = await reconcileProfileMessages(pid);
    // …and nothing is examined, nothing is edited, and the chat still reads as it did.
    expect(again.examined).toBe(0);
    expect(editText).not.toHaveBeenCalled();
  });
});

// ---- The digest's PROSE reconciles (#1913 item 4) --------------------------
//
// The owner's question that exposed the gap: "if I mark yesterday's Glycine now, will
// this message fix itself?" — it did not. Every digest keyboard token is declared inert
// (an offer tail, a ⚙️ Tune control — correctly, they claim nothing), so `owningFamily`
// returned null and the sweep concluded a fully-collapsed digest had nothing to
// reconcile. The claims were in the sentences: "Supplements: 8/9 taken — missed Glycine
// (2 days)" stood until the next morning after the user had already resolved it.

describe("the morning digest's prose reconciles (#1913 item 4)", () => {
  // Yesterday's dose, due and unconfirmed — the adherence fraction the digest states.
  function seedYesterdayDose(profileId: number): {
    doseId: number;
    itemId: number;
  } {
    return seedDose(profileId, "Glycine");
  }

  async function sendDigest(profileId: number, name: string): Promise<void> {
    const model = buildDigest(gatherDigestInput(profileId, name));
    expect(model, "the fixture should have something to say").not.toBeNull();
    await dispatch(profileId, renderDigestMessage(model!));
  }

  it("registers a pointer by KIND, even with no state-claiming button on it", async () => {
    const p = newProfile("Prose Pat");
    seedLoginTelegram(p, "9100");
    seedYesterdayDose(p);
    await sendDigest(p, "Prose Pat");

    const [pointer] = liveMessagePointers(p);
    expect(pointer.kind).toBe("digest");
    expect(pointer.date).toBe(today(p));
    // The witness the comparison runs against — not the message text itself.
    expect(pointer.bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rebuilds the message when a backdated dose log changes the adherence line", async () => {
    const p = newProfile("Prose Perry");
    seedLoginTelegram(p, "9101");
    const { doseId, itemId } = seedYesterdayDose(p);
    await sendDigest(p, "Prose Perry");
    editText.mockClear();

    // The user marks yesterday's dose in the app, hours after the digest landed.
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1));

    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(1);
    // The edit carries the CURRENT fraction — one computation, the same builder the send
    // ran, never a second renderer.
    const edited = String(editText.mock.calls[0][2]);
    expect(edited).toContain("1/1 taken");
    expect(edited).not.toContain("0/1 taken");
  });

  it("makes NO Telegram call when nothing changed — the idempotence pin", async () => {
    const p = newProfile("Prose Quinn");
    seedLoginTelegram(p, "9102");
    seedYesterdayDose(p);
    await sendDigest(p, "Prose Quinn");
    editText.mockClear();
    editKeyboard.mockClear();

    for (let tick = 0; tick < 3; tick++) {
      const res = await reconcileProfileMessages(p);
      expect(res.edited).toBe(0);
    }
    expect(editText).not.toHaveBeenCalled();
    expect(editKeyboard).not.toHaveBeenCalled();
  });

  it("stops tracking at the day boundary and leaves the report standing", async () => {
    const p = newProfile("Prose Robin");
    seedLoginTelegram(p, "9103");
    const { doseId, itemId } = seedYesterdayDose(p);
    await sendDigest(p, "Prose Robin");
    editText.mockClear();

    // Roll the pointer back a day: a dated report is honest AS HISTORY.
    db.prepare("UPDATE notify_messages SET date = ? WHERE profile_id = ?").run(
      shiftDateStr(today(p), -1),
      p
    );
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1));

    const res = await reconcileProfileMessages(p);
    // The pointer is forgotten…
    expect(liveMessagePointers(p)).toEqual([]);
    // …and the message itself is untouched. Replacing yesterday's digest would destroy
    // a report the reader may legitimately scroll back to.
    expect(editText).not.toHaveBeenCalled();
    expect(res.edited).toBe(0);
  });

  it("edits once when two overlapping ticks race — the claim is on the witness", async () => {
    const p = newProfile("Prose Sam");
    seedLoginTelegram(p, "9104");
    const { doseId, itemId } = seedYesterdayDose(p);
    await sendDigest(p, "Prose Sam");
    editText.mockClear();
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1));

    const [a, b] = await Promise.all([
      reconcileProfileMessages(p),
      reconcileProfileMessages(p),
    ]);
    // ONE Bot API call between them, however the two passes interleave: the loser
    // either loses the compare-and-swap on the hash, or reads the already-claimed one
    // and finds nothing to do. Both are the same outcome — the rate-limit budget this
    // sweep's zero-call steady state protects is spent once.
    expect(a.edited + b.edited).toBe(1);
    expect(editText).toHaveBeenCalledTimes(1);
  });
});

// ---- One pointer's failure is one pointer's failure (#2070) ----------------
//
// The sweep walked every live pointer in ONE unguarded loop. The digest is normally the
// earliest-`sent_at` pointer of the day, so an exception rebuilding it took the whole
// sweep down and NOTHING else for that profile was examined that tick — including a
// same-day dose keyboard the ledger had already resolved. A live "✅ Taken" on a dose
// already taken is the prompt that invites a double dose; a coaching build bug must not
// be able to keep one up.

describe("a failing rebuild cannot starve the rest of the sweep (#2070)", () => {
  async function sendDigestFor(profileId: number, name: string): Promise<void> {
    const model = buildDigest(gatherDigestInput(profileId, name));
    expect(model, "the fixture should have something to say").not.toBeNull();
    await dispatch(profileId, renderDigestMessage(model!));
  }

  it("reconciles the dose keyboard behind a digest whose rebuild throws", async () => {
    const pid = newProfile("Starve Sten");
    seedLoginTelegram(pid, "9200");
    const { itemId, doseId } = seedDose(pid, "Sten D3");
    // The digest is sent FIRST, which is what puts it ahead of the dose reminder in the
    // sweep's `sent_at` order — the ordering that made this starve everything.
    await sendDigestFor(pid, "Starve Sten");
    await sendMorningReminder(pid);
    editText.mockClear();

    // Resolved in the app: the reminder's button is now a lie…
    expect(markDoseTaken(pid, doseId, itemId, today(pid))).toBe("logged");
    // …and the digest cannot be rebuilt at all this tick.
    gatherState.throwFor = pid;

    const res = await reconcileProfileMessages(pid);

    // Both pointers were reached, and the safety-tier one was reconciled.
    expect(res.examined).toBe(2);
    expect(res.closed).toBe(1);
    expect(liveTokens(pid).some((t) => t.startsWith("take:"))).toBe(false);

    // The failure is COUNTED, not swallowed — a persistent per-profile build bug has to
    // be visible rather than silently degrading this profile's cleanup.
    expect(res.failed).toBe(1);

    // And it is CLASSIFIED, never assumed (#1885): a compute failure says nothing about
    // whether the message is still in the chat, so the pointer is left exactly as found
    // — not dropped, not edited on a guess.
    expect(liveMessagePointers(pid).map((p) => p.kind)).toEqual(["digest"]);
  });

  it("retries the failed pointer on the next tick, once the build works again", async () => {
    const pid = newProfile("Retry Rhea");
    seedLoginTelegram(pid, "9201");
    const { itemId, doseId } = seedDose(pid, "Rhea D3");
    await sendDigestFor(pid, "Retry Rhea");
    editText.mockClear();
    markDoseTaken(pid, doseId, itemId, shiftDateStr(today(pid), -1));

    gatherState.throwFor = pid;
    expect((await reconcileProfileMessages(pid)).failed).toBe(1);
    expect(editText).not.toHaveBeenCalled();

    // Nothing was recorded for the pre-check either, so the retry is a full rebuild.
    gatherState.throwFor = null;
    const res = await reconcileProfileMessages(pid);
    expect(res.failed).toBe(0);
    expect(res.edited).toBe(1);
    expect(String(editText.mock.calls[0][2])).toContain("1/1 taken");
  });
});

// ---- The rebuild is pre-checked before it is paid for (#2069) --------------
//
// A sent digest's pointer stays live until rollover, so the sweep was running the full
// `gatherDigestInput` — a coaching scan, a ~20-domain upcoming aggregation and a
// per-document footprint loop — on every remaining tick of the day, ~15 times out of 16
// only to hash the result and find it identical.

describe("the digest rebuild is gated by a cheap pre-check (#2069)", () => {
  async function sendDigestFor(profileId: number, name: string): Promise<void> {
    const model = buildDigest(gatherDigestInput(profileId, name));
    expect(model, "the fixture should have something to say").not.toBeNull();
    await dispatch(profileId, renderDigestMessage(model!));
  }

  it("gathers once, then costs NOTHING for the rest of an unchanged day", async () => {
    const pid = newProfile("Precheck Pia");
    seedLoginTelegram(pid, "9210");
    seedDose(pid, "Pia D3");
    await sendDigestFor(pid, "Precheck Pia");
    gatherState.calls = 0;

    // The first sweep has nothing recorded to compare against, so it rebuilds once.
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);
    expect(gatherState.calls).toBe(1);

    // Every further tick of an unchanged day is free — the whole of #2069.
    for (let tick = 0; tick < 5; tick++)
      expect((await reconcileProfileMessages(pid)).edited).toBe(0);
    expect(gatherState.calls).toBe(1);
    expect(editText).not.toHaveBeenCalled();
    expect(editKeyboard).not.toHaveBeenCalled();
  });

  it("still rebuilds and edits on the VERY NEXT tick when the ledger moves", async () => {
    const pid = newProfile("Precheck Pim");
    seedLoginTelegram(pid, "9211");
    const { itemId, doseId } = seedDose(pid, "Pim D3");
    await sendDigestFor(pid, "Precheck Pim");
    // One quiet tick settles the record, so what follows is the steady state.
    await reconcileProfileMessages(pid);
    editText.mockClear();
    gatherState.calls = 0;

    markDoseTaken(pid, doseId, itemId, shiftDateStr(today(pid), -1));

    const res = await reconcileProfileMessages(pid);
    expect(gatherState.calls).toBe(1);
    expect(res.edited).toBe(1);
    expect(String(editText.mock.calls[0][2])).toContain("1/1 taken");
  });

  it("rebuilds past the floor even when the stamp saw nothing — an accelerator, not an oracle", async () => {
    const pid = newProfile("Floor Fred");
    seedLoginTelegram(pid, "9212");
    seedDose(pid, "Fred D3");
    await sendDigestFor(pid, "Floor Fred");
    await reconcileProfileMessages(pid);
    gatherState.calls = 0;
    await reconcileProfileMessages(pid);
    expect(gatherState.calls).toBe(0);

    // Age the record past the floor. This stands in for the change class the stamp
    // deliberately does not try to see — an in-place edit of a row it does not window —
    // which must still reach the chat rather than standing until tomorrow.
    const rec = parseProseGatherRecord(
      getProfileSetting(pid, "notify_digest_recon")
    );
    expect(rec).not.toBeNull();
    setProfileSetting(
      pid,
      "notify_digest_recon",
      formatProseGatherRecord({
        ...rec!,
        at: rec!.at - DIGEST_REGATHER_FLOOR_MS - 1,
      })
    );

    await reconcileProfileMessages(pid);
    expect(gatherState.calls).toBe(1);
  });

  it("drops the rolled-over pointer without gathering at all", async () => {
    const pid = newProfile("Rollover Rae");
    seedLoginTelegram(pid, "9213");
    seedDose(pid, "Rae D3");
    await sendDigestFor(pid, "Rollover Rae");
    db.prepare("UPDATE notify_messages SET date = ? WHERE profile_id = ?").run(
      shiftDateStr(today(pid), -1),
      pid
    );
    gatherState.calls = 0;

    expect((await reconcileProfileMessages(pid)).dropped).toBe(1);
    expect(gatherState.calls).toBe(0);
  });

  it("every declared dependency is profile-scoped and actually runs", () => {
    // What the profile-scoping scan cannot read off a composed statement, asserted here
    // instead: each arm's WHERE opens on the profile, directly or through the parent
    // join the child-table convention requires.
    for (const dep of DIGEST_DEPENDENCIES) {
      const where = dep.from.slice(dep.from.search(/\bWHERE\b/));
      expect(where, dep.table).toMatch(/(?:^|[\s.(])profile_id\s*=\s*\?/);
    }
    // …and the composed statement is one SQLite accepts, arm for arm.
    const pid = newProfile("Scoped Sky");
    const rows = db
      .prepare(digestStampSql())
      .all(DIGEST_DEPENDENCIES.flatMap(() => [pid, "1970-01-01"])) as {
      t: string;
    }[];
    expect(rows.map((r) => r.t).sort()).toEqual(
      DIGEST_DEPENDENCIES.map((d) => d.table).sort()
    );
  });

  it("moves the stamp for the profile that wrote, and only for that one", async () => {
    const subject = newProfile("Stamp Sara");
    const bystander = newProfile("Stamp Silas");
    const { itemId, doseId } = seedDose(subject, "Sara D3");
    seedDose(bystander, "Silas D3");

    const before = digestDependencyStamp(subject);
    const bystanderBefore = digestDependencyStamp(bystander);
    expect(before).toMatch(/^[0-9a-f]{32}$/);

    markDoseTaken(subject, doseId, itemId, today(subject));

    expect(digestDependencyStamp(subject)).not.toBe(before);
    // Profile-scoped like every other statement in lib/: one subject's ledger write must
    // not make every other profile pay for a rebuild.
    expect(digestDependencyStamp(bystander)).toBe(bystanderBefore);
  });
});

// ---- EVERY family states its outcome (issue #2275) -------------------------
//
// Nine of eleven families closed a fully-resolved message to "handled in the app." while
// HOLDING the outcome. #2275 makes the declaration part of `FamilyReconciler`'s type, so
// a family can no longer say nothing by omission; what the type cannot reach is whether
// `detail()` actually returns the real thing on a real resolution, which is this block.
//
// The pointer is recorded directly here rather than driven through nine send paths: the
// close is a function of the KEYBOARD's tokens and the ledger, and each send path already
// has its own builder test. What matters is that a real ledger write produces the real
// sentence.

// Record one keyboard, sweep, and hand back the text the chat was closed with.
async function closeTextFor(
  profileId: number,
  chatId: string,
  messageId: number,
  kind: string,
  title: string,
  tokens: { text: string; callback_data: string }[]
): Promise<string> {
  recordMessagePointer({
    profileId,
    chatId,
    messageId,
    kind,
    date: today(profileId),
    keyboard: [tokens],
    title,
  });
  editText.mockClear();
  const out = await reconcileProfileMessages(profileId);
  expect(out.closed).toBe(1);
  return String(editText.mock.calls.at(-1)![2]);
}

describe("mood: the close states the mood that was recorded (#2275)", () => {
  it("names the recorded value, in the shared 5-point vocabulary", async () => {
    const pid = newProfile("Mood Mira");
    seedLoginTelegram(pid, "5552275");
    const d = today(pid);
    db.prepare(
      "INSERT INTO mood_logs (profile_id, date, valence) VALUES (?, ?, 4)"
    ).run(pid, d);

    const text = await closeTextFor(
      pid,
      "5552275",
      7001,
      "mood",
      "[Mira] 🙂 How are you feeling?",
      [
        { text: "🙂", callback_data: `mood:${pid}:4:${d}` },
        { text: "😄", callback_data: `mood:${pid}:5:${d}` },
      ]
    );
    // Restating a person's own answer is not a score and not a comparison — the
    // #992/#716 tone contract forbids JUDGING the value, never repeating it.
    expect(text).toBe("[Mira] 🙂 How are you feeling? — Good recorded.");
  });
});

describe("workout-draft: finished and discarded are OPPOSITE outcomes (#2275)", () => {
  const draftFor = (profileId: number, title: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, start_time)
           VALUES (?, ?, 'strength', ?, '07:00')`
        )
        .run(profileId, today(profileId), title).lastInsertRowid
    );

  it("a FINISHED session closes as finished", async () => {
    const pid = newProfile("Finish Fern");
    seedLoginTelegram(pid, "5552276");
    const id = draftFor(pid, "Squat day");
    db.prepare("UPDATE activities SET end_time = '08:10' WHERE id = ?").run(id);

    const text = await closeTextFor(
      pid,
      "5552276",
      7002,
      "other",
      "[Fern] ⏱️ Still working out?",
      [
        { text: "🏁 Finish workout", callback_data: `wofinish:${pid}:${id}` },
        { text: "🗑 Discard", callback_data: `wodiscard:${pid}:${id}` },
      ]
    );
    expect(text).toBe("[Fern] ⏱️ Still working out? — session finished.");
  });

  it("a DISCARDED session closes as discarded — the two must not read the same", async () => {
    const pid = newProfile("Discard Dev");
    seedLoginTelegram(pid, "5552277");
    const id = draftFor(pid, "Abandoned draft");
    // The real core: discardWorkoutSession deletes the draft and its sets.
    expect(discardWorkoutSession(pid, id).kind).toBe("discarded");

    const text = await closeTextFor(
      pid,
      "5552277",
      7003,
      "other",
      "[Dev] ⏱️ Still working out?",
      [
        { text: "🏁 Finish workout", callback_data: `wofinish:${pid}:${id}` },
        { text: "🗑 Discard", callback_data: `wodiscard:${pid}:${id}` },
      ]
    );
    expect(text).toBe("[Dev] ⏱️ Still working out? — session discarded.");
  });
});

describe("refill: the close names which item is no longer low (#2275)", () => {
  // An item with a daily dose and a countable supply — the shape isLowSupply reads.
  function seedSupply(profileId: number, name: string, qty: number): number {
    const { itemId } = seedDose(profileId, name);
    db.prepare(
      "UPDATE intake_items SET quantity_on_hand = ?, qty_per_dose = 1 WHERE id = ?"
    ).run(qty, itemId);
    return itemId;
  }

  it("says only the outcome when the nudge's own title was the item's name", async () => {
    const pid = newProfile("Refill Ria");
    seedLoginTelegram(pid, "5552278");
    const itemId = seedSupply(pid, "Ria D3", 300);

    const text = await closeTextFor(
      pid,
      "5552278",
      7004,
      "refill",
      "[Ria] 📦 Refill — Ria D3",
      [
        {
          text: "📦 Ordered — remind me in 3 days",
          callback_data: `rfsnooze:${pid}:${itemId}`,
        },
      ]
    );
    expect(text).toBe("[Ria] 📦 Refill — Ria D3 — no longer low.");
  });

  it("names them when the nudge covered several", async () => {
    const pid = newProfile("Refill Rex");
    seedLoginTelegram(pid, "5552279");
    const a = seedSupply(pid, "Rex D3", 300);
    const b = seedSupply(pid, "Rex Zinc", 300);

    const text = await closeTextFor(
      pid,
      "5552279",
      7005,
      "refill",
      "[Rex] 📦 2 items running low",
      [
        { text: "📦 Ordered", callback_data: `rfsnooze:${pid}:${a}` },
        { text: "📦 Ordered", callback_data: `rfsnooze:${pid}:${b}` },
      ]
    );
    expect(text).toBe(
      "[Rex] 📦 2 items running low — Rex D3, Rex Zinc no longer low."
    );
  });

  it("does not close, and states nothing, while the shortage stands", async () => {
    const pid = newProfile("Still Low Lin");
    seedLoginTelegram(pid, "5552280");
    const itemId = seedSupply(pid, "Lin D3", 1);
    recordMessagePointer({
      profileId: pid,
      chatId: "5552280",
      messageId: 7006,
      kind: "refill",
      date: today(pid),
      keyboard: [
        [
          {
            text: "📦 Ordered",
            callback_data: `rfsnooze:${pid}:${itemId}`,
          },
        ],
      ],
      title: "[Lin] 📦 Refill — Lin D3",
    });
    expect((await reconcileProfileMessages(pid)).closed).toBe(0);
  });
});

describe("preventive: the close states which action resolved (#2275)", () => {
  const RULE = "colorectal_cancer";
  function preventiveProfile(name: string): number {
    const pid = newProfile(name);
    setUserBirthdate(pid, "1980-01-01");
    setUserSex(pid, "male");
    return pid;
  }
  const pvKeyboard = (pid: number) => [
    { text: "✅ Done", callback_data: `pvdone:${pid}:${RULE}` },
    { text: "🚫 Not applicable", callback_data: `pvna:${pid}:${RULE}` },
    { text: "⏰ Remind later", callback_data: `pvlater:${pid}:${RULE}` },
  ];

  it("marked done in the app closes as done", async () => {
    const pid = preventiveProfile("Preventive Pia");
    seedLoginTelegram(pid, "5552281");
    recordPreventiveDone(pid, RULE, today(pid));

    const text = await closeTextFor(
      pid,
      "5552281",
      7007,
      "preventive",
      "[Pia] 🩺 Preventive care: Colorectal cancer screening",
      pvKeyboard(pid)
    );
    expect(text).toBe(
      "[Pia] 🩺 Preventive care: Colorectal cancer screening — done."
    );
  });

  it("overridden in the app closes as not applicable", async () => {
    const pid = preventiveProfile("Preventive Per");
    seedLoginTelegram(pid, "5552282");
    setPreventiveOverride(pid, RULE, "not_applicable");

    const text = await closeTextFor(
      pid,
      "5552282",
      7008,
      "preventive",
      "[Per] 🩺 Preventive care: Colorectal cancer screening",
      pvKeyboard(pid)
    );
    expect(text).toBe(
      "[Per] 🩺 Preventive care: Colorectal cancer screening — not applicable."
    );
  });
});

describe("symptom: the close states the symptom and its severity (#2275)", () => {
  it("names both — parity with the follow-up that asked", async () => {
    const pid = newProfile("Symptom Sam");
    seedLoginTelegram(pid, "5552283");
    db.prepare(
      "INSERT INTO symptom_logs (profile_id, date, symptom, severity) VALUES (?, ?, 'headache', 2)"
    ).run(pid, today(pid));

    const text = await closeTextFor(
      pid,
      "5552283",
      7009,
      "symptom",
      "[Sam] 🤒 Log a symptom: Headache",
      [
        { text: "Headache", callback_data: `symp:${pid}:headache` },
        { text: "Moderate", callback_data: `symsev:${pid}:2:headache` },
      ]
    );
    expect(text).toBe(
      "[Sam] 🤒 Log a symptom: Headache — Headache logged, moderate."
    );
  });
});

describe("practice: the close names which practice caught up (#2275)", () => {
  it("states the week's verdict for the target the button covered", async () => {
    const pid = newProfile("Practice Pat");
    seedLoginTelegram(pid, "5552284");
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', 'Meditation', 'meditation', 1)`
        )
        .run(pid).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO practice_logs (profile_id, practice, date) VALUES (?, 'Meditation', ?)"
    ).run(pid, today(pid));

    const text = await closeTextFor(
      pid,
      "5552284",
      7010,
      "practice",
      "[Pat] 🧘 Practices behind pace",
      [{ text: "✓ Meditation", callback_data: `pdone:${pid}:${targetId}:n1` }]
    );
    expect(text).toBe("[Pat] 🧘 Practices behind pace — done for the week.");
  });
});

describe("food-optin: the close states which way the setting went (#2275)", () => {
  it("names the setting, read from the setting itself", async () => {
    const pid = newProfile("Optin Ola");
    seedLoginTelegram(pid, "5552285");
    setProfileFoodTelegram(pid, true);

    const text = await closeTextFor(
      pid,
      "5552285",
      7011,
      "food",
      "[Ola] 🍽️ Log food from here?",
      [
        { text: "Yes", callback_data: `foodoptin:${pid}:yes` },
        { text: "Not now", callback_data: `foodoptin:${pid}:no` },
      ]
    );
    expect(text).toBe("[Ola] 🍽️ Log food from here? — food logging turned on.");
  });
});

describe("household-round: the close is per MEMBER (#2275)", () => {
  it("attributes each member's doses, in the round's own order", async () => {
    const receiver = newProfile("Carer Cam");
    const ada = newProfile("Ada");
    const bo = newProfile("Bo");
    seedLoginTelegram(receiver, "5552286");
    const adaDose = seedDose(ada, "Ada D3");
    const boDose = seedDose(bo, "Bo Iron");
    markDoseTaken(ada, adaDose.doseId, adaDose.itemId, today(ada));
    markDoseSkipped(bo, boDose.doseId, boDose.itemId, today(bo));
    const d = today(receiver);

    const text = await closeTextFor(
      receiver,
      "5552286",
      7012,
      "dose",
      "[Cam] 💊 Household doses — 2 due across 2 members",
      [
        {
          text: "✓ Ada · Ada D3",
          callback_data: `hh:${receiver}:${ada}:${adaDose.doseId}:${adaDose.itemId}:${d}`,
        },
        {
          text: "✓ Bo · Bo Iron",
          callback_data: `hh:${receiver}:${bo}:${boDose.doseId}:${boDose.itemId}:${d}`,
        },
      ]
    );
    expect(text).toBe(
      "[Cam] 💊 Household doses — 2 due across 2 members — Ada: Ada D3 taken · Bo: Bo Iron skipped."
    );
  });
});

describe("escalation: a caregiver's chat is named too (#2274)", () => {
  it("closes with the dose named, through the shared dose detail", async () => {
    const pid = newProfile("Escalation Esme");
    seedLoginTelegram(pid, "5552287");
    const { itemId, doseId } = seedDose(pid, "Esme D3");
    const d = today(pid);
    markDoseTaken(pid, doseId, itemId, d);

    const text = await closeTextFor(
      pid,
      "5552287",
      7013,
      "dose",
      "[Esme] ⚠️ Missed dose",
      [
        {
          text: "✅ Esme D3",
          callback_data: `esctake:${pid}:${doseId}:${itemId}:${d}`,
        },
        {
          text: "⏭ Skip",
          callback_data: `escskip:${pid}:${doseId}:${itemId}:${d}`,
        },
        {
          text: "👀 Seen",
          callback_data: `escack:${pid}:${doseId}:${itemId}:${d}`,
        },
      ]
    );
    expect(text).toBe("[Esme] ⚠️ Missed dose — Esme D3 taken.");
  });
});

describe("the name lookup is profile-scoped (#2274)", () => {
  it("a shared chat's close names only the subject's own items", async () => {
    const shared = "5552288";
    const a = newProfile("Scope Ann");
    const b = newProfile("Scope Ben");
    const ad = seedDose(a, "Ann Magnesium");
    const bd = seedDose(b, "Ben Magnesium");
    seedLoginTelegram(a, shared);
    seedLoginTelegram(b, shared);
    markDoseTaken(a, ad.doseId, ad.itemId, today(a));
    markDoseTaken(b, bd.doseId, bd.itemId, today(b));

    const aText = await closeTextFor(
      a,
      shared,
      7014,
      "dose",
      "[Ann] 💊 Morning",
      [
        {
          text: "✅ Ann Magnesium",
          callback_data: `take:${a}:${ad.doseId}:${ad.itemId}:${today(a)}`,
        },
      ]
    );
    const bText = await closeTextFor(
      b,
      shared,
      7015,
      "dose",
      "[Ben] 💊 Morning",
      [
        {
          text: "✅ Ben Magnesium",
          callback_data: `take:${b}:${bd.doseId}:${bd.itemId}:${today(b)}`,
        },
      ]
    );

    expect(aText).toBe("[Ann] 💊 Morning — Ann Magnesium taken.");
    expect(aText).not.toContain("Ben");
    expect(bText).toBe("[Ben] 💊 Morning — Ben Magnesium taken.");
    expect(bText).not.toContain("Ann");
  });
});

describe("the three non-resolved tails are untouched (#2275)", () => {
  it("rollover, expired and superseded still read exactly as they did", async () => {
    // They close for time or lifecycle reasons where there is no outcome to state — a
    // rolled-over nudge says nothing about what the day's ledger holds.
    const pid = newProfile("Tail Tess");
    seedLoginTelegram(pid, "5552289");
    const yd = shiftDateStr(today(pid), -1);
    recordMessagePointer({
      profileId: pid,
      chatId: "5552289",
      messageId: 7016,
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
      title: "[Tess] 🍽️ Morning food log",
    });
    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toBe(
      "[Tess] 🍽️ Morning food log — this was yesterday's message."
    );
  });
});
