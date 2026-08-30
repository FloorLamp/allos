// DB INTEGRATION TIER (#3092) — a burst is ONE MESSAGE'S ERROR.
//
// The reported defect: two dose reminders both live in one chat (dose is deliberately
// not re-issuable — the evening and the bedtime session are two outstanding claims),
// answered minutes apart the next morning. Tap proximity alone collapsed the two
// answers into ONE burst attributed to whichever message was tapped first: the second
// message rendered no correction row at all, and — worse — the surviving row's chips
// restamped BOTH doses, including the one its message never mentioned. That is the
// wrong-subject write #2264 was built to prevent, arriving through the grouping
// instead of through the binding.
//
// The fix partitions `collapseBursts` by `messageRef` before the gap rule runs, and
// threads `messageRef` into the three restamp write cores so the write partitions
// exactly as the renderer does. Both halves are pinned here through the real ledger,
// the real callback dispatcher and the real builders, with only the raw Telegram
// transport stubbed — a renderer-only fix fails the write-isolation cases.

import {
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { setTelegramBotConfig, setTimezone } from "@/lib/settings";
import { dispatch } from "@/lib/notifications";
import { buildFoodNudge } from "@/lib/notifications/food";
import {
  buildIntakeReminderForSlots,
  withDoseCorrections,
} from "@/lib/notifications/intake";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";
import {
  liveMessagePointers,
  messagePointerIdAt,
  recordMessagePointer,
} from "@/lib/notifications/message-pointers";
import { keyboardTokens } from "@/lib/notifications/reconcile-core";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import { now as clockNow } from "@/lib/clock";
import { parseUtcSql } from "@/lib/date";
import {
  getDoseCorrectionBursts,
  getRecentDoseTaps,
  markDoseTaken,
  restampDoseLogsCore,
} from "@/lib/queries/intake/adherence";
import {
  getRecentFoodTaps,
  getPracticeCorrectionBursts,
  logPracticeByTargetId,
} from "@/lib/queries";
import { restampFoodEventsCore } from "@/lib/food-log-write";
import { restampPracticeLogsCore } from "@/lib/practice-log";
import { burstFrom, chipTarget, correctionBursts } from "@/lib/correction-time";
import { correctionWriteBinding } from "@/lib/notifications/telegram-time-correction";
import {
  DOSE_TIME_PREFIXES,
  FOOD_TIME_PREFIXES,
  PRACTICE_TIME_PREFIXES,
} from "@/lib/notifications/correction-rows";
import { practiceIdentity } from "@/lib/practice";
import { seedLoginTelegram } from "./fixtures";

beforeAll(() => stubTelegramSends());

// One frozen morning in Berlin (UTC+2 in August) — the owner's report is two dose
// reminders from last night, both answered the next morning minutes apart.
const MORNING_ISO = "2026-08-05T05:30:00Z";
let priorNow: string | undefined;

beforeEach(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = MORNING_ISO;
  setTelegramBotConfig({
    telegramBotToken: "bot-for-tests",
    telegramMode: "poll",
  });
});

afterEach(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

function setNow(iso: string): void {
  process.env.ALLOS_TEST_NOW = iso;
}

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "Europe/Berlin");
  return id;
}

function cqAt(
  chatId: string,
  messageId: number,
  data: string,
  keyboard: unknown
) {
  return {
    id: `cb-${data}`,
    data,
    message: {
      message_id: messageId,
      chat: { id: Number(chatId) },
      text: "💊 reminder",
      reply_markup: { inline_keyboard: keyboard },
    },
  } as never;
}

function seedDose(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation)
         VALUES (?, ?, 1, 'medication', 'daily', 'must')`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 tab', 'evening', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

// `recorded_at` is written by SQL's real clock (the ALLOS_TEST_NOW freeze deliberately
// does not reach it), so burst spacing is pinned by stamping it explicitly after the
// real write path has created the row.
function stampDoseTap(logId: number, isoUtc: string): void {
  db.prepare(
    `UPDATE intake_item_logs SET recorded_at = ?, occurred_at = ? WHERE id = ?`
  ).run(isoUtc, isoUtc, logId);
}

function doseLogs(profileId: number) {
  return db
    .prepare(
      `SELECT l.id AS id, l.notify_message_id AS messageRef,
              l.occurred_at AS occurredAt
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? ORDER BY l.id`
    )
    .all(profileId) as {
    id: number;
    messageRef: number | null;
    occurredAt: string | null;
  }[];
}

function dosetimeTokens(msg: {
  actions?: { data?: string }[] | undefined;
}): string[] {
  return keyboardTokens(messageKeyboard(msg as never)).filter(
    (t) => t.startsWith("dosetime:") || t.startsWith("dosetimeat:")
  );
}

function foodtimeTokens(msg: {
  actions?: { data?: string }[] | undefined;
}): string[] {
  return keyboardTokens(messageKeyboard(msg as never)).filter(
    (t) => t.startsWith("foodtime:") || t.startsWith("foodtimeat:")
  );
}

function foodEvents(profileId: number) {
  return db
    .prepare(
      `SELECT id, group_key, occurred_at AS occurredAt
         FROM food_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    group_key: string;
    occurredAt: string | null;
  }[];
}

const minutesApart = (a: string | null, b: string | null): number =>
  (parseUtcSql(a)!.getTime() - parseUtcSql(b)!.getTime()) / 60_000;

// ---- the reported dose sequence, end to end ---------------------------------

describe("two dose reminders answered minutes apart stay two bursts (#3092)", () => {
  // The owner's report: the Evening and the Bedtime reminder both live overnight, the
  // Bedtime handful confirmed first the next morning, the Evening one five minutes
  // later — each from its OWN message.
  async function eveningAndBedtime(pid: number, chatId: string) {
    const date = today(pid);
    const evening = seedDose(pid, "Evening Tab");
    const bedtime = seedDose(pid, "Bedtime Tab");

    // The Evening reminder goes out for real, so its pointer is recorded exactly as
    // production records it.
    const reminderA = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    await dispatch(pid, reminderA);
    const pointerA = liveMessagePointers(pid).find((p) => p.kind === "dose")!;

    // The Bedtime reminder is a SECOND live dose message in the same chat — recorded
    // through the real pointer store rather than a second dispatch, because dose is
    // deliberately not re-issuable and both claims stand at once.
    const reminderB = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9944,
      kind: "dose",
      date,
      keyboard: messageKeyboard(reminderB),
      title: reminderB.title,
    });
    const pointerBId = messagePointerIdAt(pid, chatId, 9944)!;

    // 07:35 local — the Bedtime dose is confirmed from the Bedtime message.
    setNow("2026-08-05T05:35:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        9944,
        `take:${pid}:${bedtime.doseId}:${bedtime.itemId}:${date}`,
        messageKeyboard(reminderB)
      )
    );
    const bedtimeLog = doseLogs(pid)[0];
    expect(bedtimeLog.messageRef).toBe(pointerBId);
    stampDoseTap(bedtimeLog.id, "2026-08-05T05:35:00Z");

    // 07:40 local, five minutes later and well inside BURST_GAP_MIN — the Evening
    // dose is confirmed from the Evening message.
    setNow("2026-08-05T05:40:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointerA.messageId,
        `take:${pid}:${evening.doseId}:${evening.itemId}:${date}`,
        pointerA.keyboard
      )
    );
    const eveningLog = doseLogs(pid)[1];
    expect(eveningLog.messageRef).toBe(pointerA.id);
    stampDoseTap(eveningLog.id, "2026-08-05T05:40:00Z");

    setNow("2026-08-05T05:45:00Z");
    return { chatId, pointerA, bedtimeLog, eveningLog };
  }

  it("each message carries exactly its own dosetime tokens", async () => {
    const pid = newProfile("Burst Bela");
    const chatId = "5730901";
    seedLoginTelegram(pid, chatId);
    const { pointerA, bedtimeLog, eveningLog } = await eveningAndBedtime(
      pid,
      chatId
    );

    // Two answers, two errors, two bursts — no longer one merged row.
    const bursts = getDoseCorrectionBursts(pid, clockNow());
    expect(bursts.map((b) => b.ids)).toEqual([
      [eveningLog.id],
      [bedtimeLog.id],
    ]);

    const base = {
      title: "💊 test",
      body: "b",
      actions: [],
      kind: "dose" as const,
    };
    // The Evening message: its own confirmation, no longer swallowed by the burst the
    // Bedtime tap started — the reported symptom was this set being empty.
    const onEvening = dosetimeTokens(
      withDoseCorrections(pid, base, {
        ref: { chatId, messageId: pointerA.messageId },
      })
    );
    expect(onEvening).toContain(`dosetime:${pid}:${eveningLog.id}:30`);
    expect(onEvening.some((t) => t.includes(`:${bedtimeLog.id}:`))).toBe(false);

    // The Bedtime message: its own row only — it no longer owns the Evening dose.
    const onBedtime = dosetimeTokens(
      withDoseCorrections(pid, base, { ref: { chatId, messageId: 9944 } })
    );
    expect(onBedtime).toContain(`dosetime:${pid}:${bedtimeLog.id}:30`);
    expect(onBedtime.some((t) => t.includes(`:${eveningLog.id}:`))).toBe(false);
  });

  it("a chip on the Bedtime row moves the Bedtime dose and leaves the Evening log untouched", async () => {
    // THE WRONG-SUBJECT WRITE — the load-bearing half. The write core re-derives the
    // burst from the ledger at tap time, so a renderer-only fix would split the offer
    // and still restamp both doses here.
    const pid = newProfile("Burst Wren");
    const chatId = "5730902";
    seedLoginTelegram(pid, chatId);
    const { bedtimeLog, eveningLog } = await eveningAndBedtime(pid, chatId);

    const base = {
      title: "💊 test",
      body: "b",
      actions: [],
      kind: "dose" as const,
    };
    const onBedtime = withDoseCorrections(pid, base, {
      ref: { chatId, messageId: 9944 },
    });
    await handleCallbackQuery(
      cqAt(
        chatId,
        9944,
        `dosetime:${pid}:${bedtimeLog.id}:30`,
        messageKeyboard(onBedtime)
      )
    );

    const after = doseLogs(pid);
    // The Bedtime administration moved back 30 minutes from where it stood…
    expect(minutesApart(after[0].occurredAt, bedtimeLog.occurredAt)).toBe(-30);
    // …and the Evening administration — a dose the Bedtime message never mentioned —
    // did not move at all. This instant arms the PRN redose window (#2020).
    expect(after[1].occurredAt).toBe(eveningLog.occurredAt);
  });
});

// ---- the food twin ----------------------------------------------------------

describe("the food twin: two nudges answered minutes apart stay two bursts (#3092)", () => {
  async function twoNudges(pid: number, chatId: string) {
    const date = today(pid);
    // The first nudge goes out for real; a second is live in the same chat through
    // the real pointer store.
    await dispatch(pid, buildFoodNudge(pid, "Morning", date)!);
    const first = liveMessagePointers(pid)[0];
    const secondMsg = buildFoodNudge(pid, "Morning", date)!;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9955,
      kind: "food",
      date,
      keyboard: messageKeyboard(secondMsg),
      title: secondMsg.title,
    });

    // Tapped five minutes apart, each from its own message.
    setNow("2026-08-05T05:31:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        first.messageId,
        `food:${pid}:Morning:${date}:leafy_greens`,
        first.keyboard
      )
    );
    setNow("2026-08-05T05:36:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        9955,
        `food:${pid}:Morning:${date}:berries`,
        messageKeyboard(secondMsg)
      )
    );
    setNow("2026-08-05T05:40:00Z");
    return { date, first };
  }

  it("each message carries its own foodtime tokens, and a chip moves only its own serving", async () => {
    const pid = newProfile("Food Fern");
    const chatId = "5730903";
    seedLoginTelegram(pid, chatId);
    const { date, first } = await twoNudges(pid, chatId);

    const [greens, berries] = foodEvents(pid);
    expect(
      correctionBursts(getRecentFoodTaps(pid, clockNow()), clockNow()).map(
        (b) => b.ids
      )
    ).toEqual([[berries.id], [greens.id]]);

    // Each message renders exactly its own burst.
    const onFirst = foodtimeTokens(
      buildFoodNudge(pid, "Morning", date, undefined, {
        ref: { chatId, messageId: first.messageId },
      })!
    );
    expect(onFirst).toContain(`foodtime:${pid}:${greens.id}:30`);
    expect(onFirst.some((t) => t.includes(`:${berries.id}:`))).toBe(false);
    const onSecond = foodtimeTokens(
      buildFoodNudge(pid, "Morning", date, undefined, {
        ref: { chatId, messageId: 9955 },
      })!
    );
    expect(onSecond).toContain(`foodtime:${pid}:${berries.id}:30`);
    expect(onSecond.some((t) => t.includes(`:${greens.id}:`))).toBe(false);

    // The write partitions the same way: a chip on the first message's row moves its
    // serving and not the other message's.
    await handleCallbackQuery(
      cqAt(
        chatId,
        first.messageId,
        `foodtime:${pid}:${greens.id}:30`,
        first.keyboard
      )
    );
    const after = foodEvents(pid);
    expect(minutesApart(after[0].occurredAt, greens.occurredAt)).toBe(-30);
    expect(after[1].occurredAt).toBe(berries.occurredAt);
  });
});

// ---- the practice twin ------------------------------------------------------

describe("the practice twin: two nudges answered minutes apart stay two bursts (#3092)", () => {
  it("partitions the bursts by message and the write core moves only its own row", async () => {
    const pid = newProfile("Practice Pia");
    const chatId = "5730904";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);
    const targets = ["Sauna", "Breathwork"].map((name) =>
      Number(
        db
          .prepare(
            `INSERT INTO frequency_targets
               (profile_id, scope_kind, scope_value, scope_identity, per_week)
             VALUES (?, 'practice', ?, ?, 3)`
          )
          .run(pid, name, practiceIdentity(name)).lastInsertRowid
      )
    );

    // Two live practice messages, recorded through the real store; each tap logs
    // through the real write path carrying its own message's pointer.
    const messageRows = [4310, 4320].map((messageId) => {
      recordMessagePointer({
        profileId: pid,
        chatId,
        messageId,
        kind: "practice",
        date,
        keyboard: [],
      });
      return messagePointerIdAt(pid, chatId, messageId)!;
    });
    setNow("2026-08-05T12:00:00Z");
    logPracticeByTargetId(pid, targets[0], "page", messageRows[0]);
    setNow("2026-08-05T12:05:00Z");
    logPracticeByTargetId(pid, targets[1], "page", messageRows[1]);
    const logs = db
      .prepare(
        "SELECT id, start_time FROM practice_logs WHERE profile_id = ? ORDER BY id"
      )
      .all(pid) as { id: number; start_time: string }[];
    setNow("2026-08-05T12:10:00Z");

    // Two taps five minutes apart, two messages, two bursts — each bound to its own.
    const bursts = getPracticeCorrectionBursts(pid, clockNow());
    expect(bursts.map((b) => b.ids)).toEqual([[logs[1].id], [logs[0].id]]);
    expect(
      getPracticeCorrectionBursts(pid, clockNow(), {
        messageRef: messageRows[0],
        isNewest: false,
      }).map((b) => b.ids)
    ).toEqual([[logs[0].id]]);
    expect(
      getPracticeCorrectionBursts(pid, clockNow(), {
        messageRef: messageRows[1],
        isNewest: false,
      }).map((b) => b.ids)
    ).toEqual([[logs[1].id]]);

    // The write core partitions the same way: anchored on the first tap, it moves the
    // Sauna session's stored HH:MM and leaves the other message's row untouched.
    const out = restampPracticeLogsCore(pid, logs[0].id, (row) => {
      const at = new Date(row.statedAt ?? row.tapAt);
      return new Date(at.getTime() - 30 * 60_000);
    });
    expect(out).toEqual({ kind: "restamped", count: 1 });
    const after = db
      .prepare(
        "SELECT id, start_time FROM practice_logs WHERE profile_id = ? ORDER BY id"
      )
      .all(pid) as { id: number; start_time: string }[];
    expect(after[0].start_time).not.toBe(logs[0].start_time);
    expect(after[1].start_time).toBe(logs[1].start_time);
  });
});

// ---- the binding, re-checked at tap time ------------------------------------

describe("the binding is re-checked at tap time (#3092 follow-up)", () => {
  const answer = vi.mocked(answerCallbackQuery);

  // Provenance is MUTABLE between render and tap: the pointer prune/close lifecycle
  // deletes `notify_messages` rows routinely, and `ON DELETE SET NULL` flips the ledger
  // rows that message stamped to unattributed. From there the partition itself cannot
  // protect the write — the tapped log has merged into the null partition, possibly
  // with a web one-tap the keyboard never showed. So the handler re-checks the SAME
  // binding rule the renderer applied, at tap time, and fails closed (#2264): a message
  // may only correct a burst it may still show.
  it("a chip from a pruned-pointer message refuses; the merged null partition is not written", async () => {
    const pid = newProfile("Prune Petra");
    const chatId = "5730905";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);
    const evening = seedDose(pid, "Evening Tab");
    const web = seedDose(pid, "Water Tab");

    // The reminder goes out for real and is answered from its own message.
    const reminderA = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    await dispatch(pid, reminderA);
    const pointerA = liveMessagePointers(pid).find((p) => p.kind === "dose")!;
    setNow("2026-08-05T05:35:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointerA.messageId,
        `take:${pid}:${evening.doseId}:${evening.itemId}:${date}`,
        pointerA.keyboard
      )
    );
    const chatLog = doseLogs(pid)[0];
    expect(chatLog.messageRef).toBe(pointerA.id);
    stampDoseTap(chatLog.id, "2026-08-05T05:35:00Z");

    // A newer dose pointer exists, so message A is no longer the newest of its kind…
    const reminderB = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9966,
      kind: "dose",
      date,
      keyboard: messageKeyboard(reminderB),
      title: reminderB.title,
    });
    // …and a WEB one-tap logs another dose five minutes after the chat confirm —
    // honestly unattributed, and never shown on message A.
    markDoseTaken(pid, web.doseId, web.itemId, date, "page");
    const webLog = doseLogs(pid)[1];
    expect(webLog.messageRef).toBeNull();
    stampDoseTap(webLog.id, "2026-08-05T05:40:00Z");
    setNow("2026-08-05T05:45:00Z");

    // At render time message A carries exactly its own row — the keyboard a stale chat
    // still shows.
    const base = {
      title: "💊 test",
      body: "b",
      actions: [],
      kind: "dose" as const,
    };
    const onA = withDoseCorrections(pid, base, {
      ref: { chatId, messageId: pointerA.messageId },
    });
    const onATokens = dosetimeTokens(onA);
    expect(onATokens).toContain(`dosetime:${pid}:${chatLog.id}:30`);
    expect(onATokens.some((t) => t.includes(`:${webLog.id}:`))).toBe(false);

    // The prune: message A's pointer row is deleted (pruneMessagePointers' 3-day
    // retention, dropMessagePointer). The FK flips the chat log to NULL, merging it
    // into the web tap's partition.
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(pointerA.id);
    expect(doseLogs(pid)[0].messageRef).toBeNull();

    // The tap the stale keyboard still offers. Without the tap-time binding re-check
    // the core would restamp the MERGED burst — moving the web administration falsely
    // 30 minutes earlier and opening its PRN redose window early.
    const before = doseLogs(pid);
    answer.mockClear();
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointerA.messageId,
        `dosetime:${pid}:${chatLog.id}:30`,
        messageKeyboard(onA)
      )
    );
    const after = doseLogs(pid);
    // Nothing was written — not the tapped log (all-or-nothing, fail closed)…
    expect(after[0].occurredAt).toBe(before[0].occurredAt);
    // …and above all not the web administration the message never mentioned.
    expect(after[1].occurredAt).toBe(before[1].occurredAt);
    // And the refusal is SPOKEN, as a dismissed alert — this is a medication ledger.
    expect(answer).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("can't correct"),
      { alert: true }
    );
  });

  it("the guard is domain-blind: a pruned food nudge's chip refuses instead of writing", async () => {
    const pid = newProfile("Prune Fila");
    const chatId = "5730906";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);

    await dispatch(pid, buildFoodNudge(pid, "Morning", date)!);
    const pointer = liveMessagePointers(pid)[0];
    setNow("2026-08-05T05:31:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointer.messageId,
        `food:${pid}:Morning:${date}:berries`,
        pointer.keyboard
      )
    );
    const [event] = foodEvents(pid);
    setNow("2026-08-05T05:40:00Z");
    const rendered = buildFoodNudge(pid, "Morning", date, undefined, {
      ref: { chatId, messageId: pointer.messageId },
    })!;
    expect(foodtimeTokens(rendered)).toContain(
      `foodtime:${pid}:${event.id}:30`
    );

    // A newer food pointer appears, then the tapped message's pointer is pruned.
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9977,
      kind: "food",
      date,
      keyboard: [],
      title: "🍽️ newer",
    });
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(pointer.id);

    await handleCallbackQuery(
      cqAt(
        chatId,
        pointer.messageId,
        `foodtime:${pid}:${event.id}:30`,
        messageKeyboard(rendered)
      )
    );
    expect(foodEvents(pid)[0].occurredAt).toBe(event.occurredAt);
  });
});

// ---- the binding, re-evaluated INSIDE the write transaction -----------------

describe("the write transaction re-binds for itself (#3092 follow-up, check-to-write gap)", () => {
  // The handler's binding check and the core's write are separated by an `await`, and
  // in webhook mode a concurrent handler's synchronous pointer delete can land in that
  // gap: the anchor's provenance flips to NULL, the burst the core re-derives merges
  // with taps the message never showed, and the handler's already-passed check protects
  // nothing. So each core re-evaluates the SAME predicate inside its own transaction.
  // These tests pin that door: the handler door PASSES first, the pointer delete lands,
  // and the core — called with the very predicate the handler had built — must refuse.

  it("dose: the core refuses when the pointer died between check and write", async () => {
    const pid = newProfile("Race Rada");
    const chatId = "5730907";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);
    const evening = seedDose(pid, "Evening Tab");
    const web = seedDose(pid, "Water Tab");

    const reminderA = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    await dispatch(pid, reminderA);
    const pointerA = liveMessagePointers(pid).find((p) => p.kind === "dose")!;
    setNow("2026-08-05T05:35:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointerA.messageId,
        `take:${pid}:${evening.doseId}:${evening.itemId}:${date}`,
        pointerA.keyboard
      )
    );
    const chatLog = doseLogs(pid)[0];
    stampDoseTap(chatLog.id, "2026-08-05T05:35:00Z");
    // A newer pointer, and a web administration five minutes after the chat confirm.
    const reminderB = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9988,
      kind: "dose",
      date,
      keyboard: messageKeyboard(reminderB),
      title: reminderB.title,
    });
    markDoseTaken(pid, web.doseId, web.itemId, date, "page");
    stampDoseTap(doseLogs(pid)[1].id, "2026-08-05T05:40:00Z");
    setNow("2026-08-05T05:45:00Z");

    // The handler door: the predicate the handler builds, passing against the burst it
    // derived — the state the real handler carries across its `await`.
    const guard = correctionWriteBinding(
      pid,
      DOSE_TIME_PREFIXES,
      chatId,
      pointerA.messageId
    );
    const checked = burstFrom(getRecentDoseTaps(pid, clockNow()), chatLog.id)!;
    expect(guard(checked)).toBe(true);

    // The interleaved delete lands in the gap…
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(pointerA.id);

    // …and the write transaction, re-deriving the now-merged burst, refuses it.
    const before = doseLogs(pid);
    const out = restampDoseLogsCore(
      pid,
      chatLog.id,
      (row) => chipTarget(row, 30, clockNow()),
      guard
    );
    expect(out).toEqual({ kind: "not-bound" });
    const after = doseLogs(pid);
    expect(after[0].occurredAt).toBe(before[0].occurredAt);
    // The web administration the message never mentioned — the PRN redose instant.
    expect(after[1].occurredAt).toBe(before[1].occurredAt);
  });

  it("food: the core refuses when the pointer died between check and write", async () => {
    const pid = newProfile("Race Fen");
    const chatId = "5730908";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);
    await dispatch(pid, buildFoodNudge(pid, "Morning", date)!);
    const pointer = liveMessagePointers(pid)[0];
    setNow("2026-08-05T05:31:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointer.messageId,
        `food:${pid}:Morning:${date}:berries`,
        pointer.keyboard
      )
    );
    const [event] = foodEvents(pid);
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9989,
      kind: "food",
      date,
      keyboard: [],
      title: "🍽️ newer",
    });
    setNow("2026-08-05T05:40:00Z");

    const guard = correctionWriteBinding(
      pid,
      FOOD_TIME_PREFIXES,
      chatId,
      pointer.messageId
    );
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(pointer.id);
    const out = restampFoodEventsCore(
      pid,
      event.id,
      (row) => chipTarget(row, 30, clockNow()),
      guard
    );
    expect(out).toEqual({ kind: "not-bound" });
    expect(foodEvents(pid)[0].occurredAt).toBe(event.occurredAt);
  });

  it("practice: the core refuses when the pointer died between check and write", async () => {
    const pid = newProfile("Race Pax");
    const chatId = "5730909";
    seedLoginTelegram(pid, chatId);
    const date = today(pid);
    const targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (?, 'practice', ?, ?, 3)`
        )
        .run(pid, "Sauna", practiceIdentity("Sauna")).lastInsertRowid
    );
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 4410,
      kind: "practice",
      date,
      keyboard: [],
    });
    const messageRow = messagePointerIdAt(pid, chatId, 4410)!;
    setNow("2026-08-05T12:00:00Z");
    logPracticeByTargetId(pid, targetId, "page", messageRow);
    const logId = (
      db
        .prepare(
          "SELECT id, start_time FROM practice_logs WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
        )
        .get(pid) as { id: number; time: string }
    ).id;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 4420,
      kind: "practice",
      date,
      keyboard: [],
    });
    setNow("2026-08-05T12:10:00Z");

    const guard = correctionWriteBinding(
      pid,
      PRACTICE_TIME_PREFIXES,
      chatId,
      4410
    );
    const timeBefore = (
      db
        .prepare("SELECT start_time FROM practice_logs WHERE id = ?")
        .get(logId) as {
        time: string;
      }
    ).time;
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(messageRow);
    const out = restampPracticeLogsCore(
      pid,
      logId,
      (row) => chipTarget(row, 30, clockNow()),
      guard
    );
    expect(out).toEqual({ kind: "not-bound" });
    expect(
      (
        db
          .prepare("SELECT start_time FROM practice_logs WHERE id = ?")
          .get(logId) as {
          time: string;
        }
      ).time
    ).toBe(timeBefore);
  });
});
