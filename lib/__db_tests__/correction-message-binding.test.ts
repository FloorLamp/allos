// DB INTEGRATION TIER (#2264) — correction rows bind to the MESSAGE that produced them.
//
// The reported defect: `getFoodCorrectionBursts(profileId, now)` was message-blind, so a
// 7:30 "Morning food log" message — rebuilt by the food family's sweep after a midday
// tap — adopted the 12:42 midday burst's rows, and its chips RESTAMPED the midday
// servings from the wrong message. The dose side (`getDoseCorrectionBursts`) was
// identical by design, so both regressions are pinned here, through the real schema
// (migration 170's provenance link), the real callback dispatcher, the real builders
// and the real sweep, with only the raw Telegram transport stubbed.

import {
  afterEach,
  beforeAll,
  beforeEach,
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
} from "@/lib/notifications/supplements";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import {
  correctionMessageBinding,
  liveMessagePointers,
  recordMessagePointer,
  type MessagePointer,
} from "@/lib/notifications/message-pointers";
import { keyboardTokens } from "@/lib/notifications/reconcile-core";
import { messageKeyboard } from "@/lib/notifications/telegram-render";
import { now as clockNow } from "@/lib/clock";
import {
  getDoseCorrectionBursts,
  markDoseTaken,
} from "@/lib/queries/intake/adherence";
import { getFoodCorrectionBursts } from "@/lib/queries";
import { seedLoginTelegram } from "./fixtures";

// This spec exercises the logic ABOVE the wire, so the four Telegram
// primitives are stubbed for it (lib/__db_tests__/telegram-spies.ts). They
// delegate to the real module by default, so this opt-in is what replaces the
// per-spec `vi.mock` that used to cost this file a private module registry.
beforeAll(() => stubTelegramSends());

// One frozen day in Berlin (UTC+2 in August): the Morning send is 07:30 local
// (05:30Z), the midday tap 12:42 local (10:42Z) — the screenshot's own clock.
const MORNING_ISO = "2026-08-05T05:30:00Z";
const MIDDAY_ISO = "2026-08-05T10:42:00Z";
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

// A callback query addressed at a SPECIFIC delivered message — the (chat, message)
// pair is what the handler resolves provenance and rebuild binding from.
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
      text: "🍽️ food log",
      reply_markup: { inline_keyboard: keyboard },
    },
  } as never;
}

function foodEvents(profileId: number) {
  return db
    .prepare(
      `SELECT id, group_key, notify_message_id
         FROM food_log_events WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    group_key: string;
    notify_message_id: number | null;
  }[];
}

function foodtimeTokens(msg: {
  actions?: { data?: string }[] | undefined;
}): string[] {
  return keyboardTokens(messageKeyboard(msg as never)).filter(
    (t) => t.startsWith("foodtime:") || t.startsWith("foodtimeat:")
  );
}

function dosetimeTokens(msg: {
  actions?: { data?: string }[] | undefined;
}): string[] {
  return keyboardTokens(messageKeyboard(msg as never)).filter(
    (t) => t.startsWith("dosetime:") || t.startsWith("dosetimeat:")
  );
}

// ---- the migration's own contract (170) -------------------------------------

describe("migration 170 — the provenance link (#2264)", () => {
  it("adds a nullable notify_messages link with ON DELETE SET NULL to both ledgers", () => {
    for (const table of ["food_log_events", "intake_item_logs"]) {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
        notnull: number;
      }[];
      const col = cols.find((c) => c.name === "notify_message_id");
      expect(col, `${table}.notify_message_id`).toBeTruthy();
      expect(col!.notnull).toBe(0);
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
        table: string;
        from: string;
        on_delete: string;
      }[];
      const fk = fks.find((f) => f.from === "notify_message_id");
      expect(fk?.table).toBe("notify_messages");
      expect(fk?.on_delete).toBe("SET NULL");
    }
  });

  it("degrades a pruned message's bursts to UNATTRIBUTED rather than orphaning them", async () => {
    const pid = newProfile("Prune Pia");
    seedLoginTelegram(pid, "5664001");
    await dispatch(pid, buildFoodNudge(pid, "Morning", today(pid))!);
    const pointer = liveMessagePointers(pid)[0];
    await handleCallbackQuery(
      cqAt(
        "5664001",
        pointer.messageId,
        `food:${pid}:Morning:${today(pid)}:berries`,
        pointer.keyboard
      )
    );
    expect(foodEvents(pid)[0].notify_message_id).toBe(pointer.id);
    // The prune/close lifecycle deletes pointer rows routinely; the FK turns that
    // into "unattributed" (rides only the newest live message), never a dangling id.
    db.prepare(`DELETE FROM notify_messages WHERE id = ?`).run(pointer.id);
    expect(foodEvents(pid)[0].notify_message_id).toBeNull();
  });
});

// ---- the reported food sequence, end to end ---------------------------------

describe("a food correction row renders only on the message that produced it (#2264)", () => {
  async function morningAndMidday(pid: number, chatId: string) {
    const date = today(pid);
    // 07:30 — the Morning nudge goes out for real, so its pointer is recorded exactly
    // as production records it.
    await dispatch(pid, buildFoodNudge(pid, "Morning", date)!);
    const morning = liveMessagePointers(pid)[0];
    // 07:31 — it is tapped, and the tap's ledger row records THIS message.
    setNow("2026-08-05T05:31:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        morning.messageId,
        `food:${pid}:Morning:${date}:leafy_greens`,
        morning.keyboard
      )
    );
    // 12:40 — a Midday message is live in the same chat. Recorded through the real
    // pointer store rather than a second dispatch: the #947 rotation strips a
    // predecessor best-effort, and the reported screenshot is exactly the case where
    // the older message is STILL live with its keyboard.
    setNow("2026-08-05T10:40:00Z");
    const middayMsg = buildFoodNudge(pid, "Midday", date)!;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9911,
      kind: "food",
      date,
      keyboard: messageKeyboard(middayMsg),
      title: middayMsg.title,
    });
    // 12:42 — the Midday message is tapped; its burst belongs to IT.
    setNow(MIDDAY_ISO);
    await handleCallbackQuery(
      cqAt(
        chatId,
        9911,
        `food:${pid}:Midday:${date}:berries`,
        messageKeyboard(middayMsg)
      )
    );
    return { date, morning };
  }

  it("the Morning rebuild never adopts the 12:42 burst; the Midday message carries exactly its own", async () => {
    const pid = newProfile("Subject Sana");
    const chatId = "5664002";
    seedLoginTelegram(pid, chatId);
    const { date, morning } = await morningAndMidday(pid, chatId);

    const events = foodEvents(pid);
    expect(events).toHaveLength(2);
    const middayBurstAnchor = events[1].id;
    // The midday burst is fresh and would previously have ridden EVERY live food
    // keyboard — that unfiltered set is exactly one burst.
    expect(getFoodCorrectionBursts(pid, clockNow())).toHaveLength(1);

    // The Morning message's own rebuild — the reported failure: it grew the midday
    // burst's chips, whose taps restamp the midday servings from the wrong message.
    const morningRebuilt = buildFoodNudge(pid, "Morning", date, undefined, {
      ref: { chatId, messageId: morning.messageId },
    })!;
    expect(foodtimeTokens(morningRebuilt)).toEqual([]);

    // The Midday message carries exactly its own burst.
    const middayRebuilt = buildFoodNudge(pid, "Midday", date, undefined, {
      ref: { chatId, messageId: 9911 },
    })!;
    expect(foodtimeTokens(middayRebuilt)).toEqual([
      `foodtimeat:${pid}:${middayBurstAnchor}:open`,
      `foodtime:${pid}:${middayBurstAnchor}:30`,
      `foodtime:${pid}:${middayBurstAnchor}:60`,
    ]);
  });

  it("the sweep reconciles the same way: the old message strips, the new one keeps its rows", async () => {
    const pid = newProfile("Sweep Sable");
    const chatId = "5664003";
    seedLoginTelegram(pid, chatId);
    await morningAndMidday(pid, chatId);
    const middayBurstAnchor = foodEvents(pid)[1].id;

    // 12:45 — the tick's sweep re-renders every live food message from the builder.
    setNow("2026-08-05T10:45:00Z");
    await reconcileProfileMessages(pid);
    const byMessage = new Map(
      liveMessagePointers(pid).map((p: MessagePointer) => [
        p.messageId,
        keyboardTokens(p.keyboard),
      ])
    );
    // The Morning message: its own burst lapsed hours ago, and the midday burst is
    // not its subject — no correction token survives on it.
    const morningTokens = [...byMessage.entries()].find(
      ([id]) => id !== 9911
    )![1];
    expect(morningTokens.some((t) => t.startsWith("foodtime"))).toBe(false);
    // Its quick-log buttons still stand — the food family's buttons never die.
    expect(morningTokens.some((t) => t.startsWith("food:"))).toBe(true);
    // The Midday message keeps exactly its own rows.
    const middayTokens = byMessage.get(9911)!;
    expect(middayTokens).toContain(`foodtime:${pid}:${middayBurstAnchor}:30`);
  });

  it("a fresh send carries only unattributed bursts, never another message's", async () => {
    const pid = newProfile("Fresh Farah");
    const chatId = "5664004";
    seedLoginTelegram(pid, chatId);
    const { date } = await morningAndMidday(pid, chatId);
    // At 12:43 the midday burst is fresh but ATTRIBUTED — a brand-new send must not
    // adopt it (its chips would restamp another message's servings).
    setNow("2026-08-05T10:43:00Z");
    expect(foodtimeTokens(buildFoodNudge(pid, "Midday", date)!)).toEqual([]);
  });
});

// ---- the dose twin ----------------------------------------------------------

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

// `taken_at` is written by SQL's real clock (the ALLOS_TEST_NOW freeze deliberately
// does not reach it), so burst freshness is pinned by stamping it explicitly after the
// real write path has created the row.
function stampTap(logId: number, sqlUtc: string): void {
  db.prepare(
    `UPDATE intake_item_logs SET taken_at = ?, recorded_at = ? WHERE id = ?`
  ).run(sqlUtc, sqlUtc, logId);
}

function doseLogs(profileId: number) {
  return db
    .prepare(
      `SELECT l.id AS id, l.notify_message_id AS messageRef
         FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? ORDER BY l.id`
    )
    .all(profileId) as { id: number; messageRef: number | null }[];
}

describe("a dose correction row renders only on the message that produced it (#2264)", () => {
  it("binds symmetrically: attribution sticks to the reminder tapped, an old reminder adopts nothing, an unattributed confirm rides only the newest", async () => {
    const pid = newProfile("Dose Dara");
    const chatId = "5664010";
    seedLoginTelegram(pid, chatId);
    const a = seedDose(pid, "Alpha Tab");
    const b = seedDose(pid, "Beta Tab");
    const c = seedDose(pid, "Gamma Tab");
    const date = today(pid);

    // 07:30 — the reminder goes out for real (covers all three evening doses).
    const reminderA = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    await dispatch(pid, reminderA);
    const pointerA = liveMessagePointers(pid).find((p) => p.kind === "dose")!;

    // 07:31 — Alpha is confirmed FROM that message; the log row records it.
    setNow("2026-08-05T05:31:00Z");
    await handleCallbackQuery(
      cqAt(
        chatId,
        pointerA.messageId,
        `take:${pid}:${a.doseId}:${a.itemId}:${date}`,
        pointerA.keyboard
      )
    );
    expect(doseLogs(pid)).toHaveLength(1);
    expect(doseLogs(pid)[0].messageRef).toBe(pointerA.id);
    stampTap(doseLogs(pid)[0].id, "2026-08-05 05:31:00");

    // 12:40 — a NEWER dose message is live in the same chat (the pointer store is
    // production's own; a second dispatch would supersede-close A, and the reported
    // case is precisely an older message still live).
    setNow("2026-08-05T10:40:00Z");
    const reminderB = buildIntakeReminderForSlots(pid, ["Evening"])!.message;
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9922,
      kind: "dose",
      date,
      keyboard: messageKeyboard(reminderB),
      title: reminderB.title,
    });

    // 12:42 — Beta is confirmed from the NEW message.
    setNow(MIDDAY_ISO);
    await handleCallbackQuery(
      cqAt(
        chatId,
        9922,
        `take:${pid}:${b.doseId}:${b.itemId}:${date}`,
        messageKeyboard(reminderB)
      )
    );
    const betaLog = doseLogs(pid)[1];
    expect(betaLog.messageRef).not.toBeNull();
    expect(betaLog.messageRef).not.toBe(pointerA.id);
    stampTap(betaLog.id, "2026-08-05 10:42:00");

    // And Gamma is confirmed from the WEB — no message, honestly unattributed. Its
    // tap sits 18 minutes after Beta's, past BURST_GAP_MIN, so it is its own burst
    // rather than a burst-mate of the chat-confirmed one.
    markDoseTaken(pid, c.doseId, c.itemId, date);
    const gammaLog = doseLogs(pid)[2];
    expect(gammaLog.messageRef).toBeNull();
    stampTap(gammaLog.id, "2026-08-05 11:00:00");

    setNow("2026-08-05T11:05:00Z");
    const base = {
      title: "💊 test",
      body: "b",
      actions: [],
      kind: "dose" as const,
    };
    // Message-blind, both fresh confirms form bursts — the set the defect used to
    // pour onto every live keyboard.
    expect(getDoseCorrectionBursts(pid, clockNow()).length).toBeGreaterThan(0);

    // The OLD reminder (the 7:30 message): its own burst lapsed, the fresh ones are
    // not its subject — it adopts nothing, exactly like the Morning food message.
    const onA = withDoseCorrections(pid, base, {
      ref: { chatId, messageId: pointerA.messageId },
    });
    expect(dosetimeTokens(onA)).toEqual([]);

    // The NEW reminder: Beta's burst is ATTRIBUTED to it, and Gamma's unattributed
    // burst rides it too — it is the newest live dose message in this chat.
    const onB = withDoseCorrections(pid, base, {
      ref: { chatId, messageId: 9922 },
    });
    const onBTokens = dosetimeTokens(onB);
    expect(onBTokens).toContain(`dosetime:${pid}:${betaLog.id}:30`);
    expect(onBTokens).toContain(`dosetime:${pid}:${gammaLog.id}:30`);

    // A yet-newer dose message appears: attribution STICKS (Beta stays on 9922, and
    // never moves to the newcomer), while the unattributed Gamma burst moves to the
    // newest — never an older one.
    const reminderC = buildIntakeReminderForSlots(pid, ["Evening"]);
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: 9933,
      kind: "dose",
      date,
      keyboard: reminderC ? messageKeyboard(reminderC.message) : [],
      title: "💊 newest",
    });
    const onBAfter = dosetimeTokens(
      withDoseCorrections(pid, base, { ref: { chatId, messageId: 9922 } })
    );
    expect(onBAfter).toContain(`dosetime:${pid}:${betaLog.id}:30`);
    expect(onBAfter).not.toContain(`dosetime:${pid}:${gammaLog.id}:30`);
    const onC = dosetimeTokens(
      withDoseCorrections(pid, base, { ref: { chatId, messageId: 9933 } })
    );
    expect(onC).toContain(`dosetime:${pid}:${gammaLog.id}:30`);
    expect(onC).not.toContain(`dosetime:${pid}:${betaLog.id}:30`);
  });

  it("the binding resolver names the pointer and the newest-of-kind honestly", async () => {
    const pid = newProfile("Bind Bea");
    const chatId = "5664011";
    seedLoginTelegram(pid, chatId);
    await dispatch(pid, buildFoodNudge(pid, "Morning", today(pid))!);
    const pointer = liveMessagePointers(pid)[0];

    // The delivered message binds to its own pointer row, newest of its kind.
    expect(
      correctionMessageBinding(pid, "food", {
        chatId,
        messageId: pointer.messageId,
      })
    ).toEqual({ messageRef: pointer.id, isNewest: true });
    // A fresh send is the null ref: no pointer yet, vacuously newest.
    expect(correctionMessageBinding(pid, "food", null)).toEqual({
      messageRef: null,
      isNewest: true,
    });
    // Another kind's newest does not answer for this one: with a newer food pointer
    // recorded, the older message stops being newest but keeps its identity.
    recordMessagePointer({
      profileId: pid,
      chatId,
      messageId: pointer.messageId + 500,
      kind: "food",
      date: today(pid),
      keyboard: [[{ text: "x", callback_data: `food:${pid}:Midday:x:y` }]],
      title: "🍽️ newer",
    });
    expect(
      correctionMessageBinding(pid, "food", {
        chatId,
        messageId: pointer.messageId,
      })
    ).toEqual({ messageRef: pointer.id, isNewest: false });
  });
});
