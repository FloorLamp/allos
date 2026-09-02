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

// THE TAP-TIME SWEEP MUST NOT BE ABLE TO FAIL THE TAP (#3933). The one thing a spec
// cannot arrange with real data is the sweep itself blowing up — every per-pointer
// failure is already isolated inside it (#2070) — so it is forced here, for one profile.
// `swept` records the sweep's ARGUMENTS as the tap path passed them — who, and with
// what budget. Both halves are load-bearing: the profile is the only trace a tap whose
// own rebuild threw still reached the sweep (#3951 F4), since the write and the answer
// both already landed; and the budget is the only place the TAP PATH's bound is
// visible, because the sweep's own guard calls it directly and would go on passing if
// this caller quietly stopped handing one over (#3951 F5).
const tapSweepState = vi.hoisted(() => ({
  throwFor: null as number | null,
  swept: [] as { profileId: number; budgetMs: number | undefined }[],
}));

vi.mock("@/lib/notifications/reconcile", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/notifications/reconcile")>();
  return {
    ...actual,
    reconcileProfileMessages: (
      ...args: Parameters<typeof actual.reconcileProfileMessages>
    ) => {
      tapSweepState.swept.push({ profileId: args[0], budgetMs: args[1] });
      if (tapSweepState.throwFor === args[0])
        throw new Error("tap sweep blew up");
      return actual.reconcileProfileMessages(...args);
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
import { shiftDateStr, utcSqlString } from "@/lib/date";
import { formatMonthDay } from "@/lib/format-date";
import {
  setTelegramBotConfig,
  setTimezone,
  setProfileBirthdate,
  setProfileSex,
} from "@/lib/settings";
import {
  logAdministration,
  markDoseTaken,
  markDoseSkipped,
  redoseWindowState,
} from "@/lib/queries";
import {
  recordPreventiveDone,
  setPreventiveOverride,
} from "@/lib/queries/upcoming/preventive";
import { setProfileFoodTelegram } from "@/lib/settings/notifications";
import { discardWorkoutSession } from "@/lib/workout-finish";
import { dispatch } from "@/lib/notifications";
import { composeForSend } from "@/lib/notifications/compose";
import {
  buildIntakeReminderForSlots,
  renderDoseSession,
  slotSessionForKeyboard,
  STACK_OFFER_FAMILY,
} from "@/lib/notifications/intake";
import { mintOffer } from "@/lib/notifications/offer-store";
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
  answerCallbackQuery,
  editMessageReplyMarkupRaw,
  editMessageTextRaw,
  TELEGRAM_CALL_TIMEOUT_MS,
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
import {
  handleCallbackQuery,
  TAP_SWEEP_BUDGET_MS,
} from "@/lib/notifications/telegram-callbacks";
import { tuneToggleToken } from "@/lib/notifications/digest-tune";
import { instantNow } from "@/lib/clock";
import { seedLoginTelegram } from "./fixtures";

// A callback query shaped like the one Telegram delivers, carrying the keyboard the
// handlers read their context back off.
function tapCq(
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
      text: "reminder",
      reply_markup: { inline_keyboard: keyboard },
    },
  } as never;
}

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
  tapSweepState.swept = [];
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
  name: string,
  stack: string | null = null
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, stack)
         VALUES (?, ?, 1, 'supplement', 'daily', 'must', ?)`
      )
      .run(profileId, name, stack).lastInsertRowid
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

// Pin a taken dose's stored administration instants (UTC, SQL shape), so the receipt's
// rendering can be asserted against a KNOWN time instead of the wall clock.
//
// `occurredAt` may be null — that is the OLDER-DATA shape, from before the column
// existed — and `getTakenDoseTimes` COALESCEs to `recorded_at`, which the schema makes
// NOT NULL. A taken scheduled dose therefore always has an instant to state; the
// tally's untimed arm exists for a stored value that will not parse.
function stampDoseTakenAt(
  profileId: number,
  doseId: number,
  recordedAt: string,
  occurredAt: string | null = recordedAt
): void {
  db.prepare(
    `UPDATE intake_item_logs
        SET occurred_at = ?, recorded_at = ?
      WHERE dose_id = ? AND status = 'taken'
        AND dose_id IN (SELECT d.id FROM intake_item_doses d
                          JOIN intake_items i ON i.id = d.item_id
                         WHERE i.profile_id = ?)`
  ).run(occurredAt, recordedAt, doseId, profileId);
}

function seedPrnMedication(
  profileId: number,
  name: string
): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            min_interval_hours, max_daily_count, redose_notice)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', 6, 4, 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses
           (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'anytime', 'any', 0)`
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
    expect(markDoseTaken(pid, doseId, itemId, today(pid), "page")).toBe(
      "logged"
    );
    // …and until the tick runs, both chats still claim it is outstanding.
    expect(liveTokens(pid).filter((t) => t.startsWith("take:")).length).toBe(2);

    const out = await reconcileProfileMessages(pid);

    expect(out.closed).toBe(2);
    expect(liveTokens(pid).some((t) => t.includes(`:${doseId}:`))).toBe(false);
    // Both copies were CLOSED, not silently sent again.
    expect(editText).toHaveBeenCalledTimes(2);
  });

  // ---- The per-stack one-tap on the offer substrate (#3282) ----------------
  //
  // Both cases pin a mechanism the rest of the suite CANNOT SEE: each was deleted
  // outright during review and all 17193 pure and 6843 db tests stayed green while the
  // behaviour underneath was plainly wrong. That is the only reason they are here.

  // THE STACK BUTTON MUST BE ABLE TO DIE. The sweep's `stacktake:` arm is the only
  // thing that retires this token; without it a fully resolved reminder EDITS into a
  // completion summary instead of CLOSING, and the outcome-detail receipt this family
  // closes with (#2170/#2274) is never spoken.
  it("a fully resolved stack lets the reminder CLOSE, not merely re-render", async () => {
    const pid = newProfile("Stack Steph");
    const a = seedDose(pid, "Steph A", "AM stack");
    const b = seedDose(pid, "Steph B", "AM stack");
    const c = seedDose(pid, "Steph C");
    seedLoginTelegram(pid, "5553282");
    await sendMorningReminder(pid);
    expect(liveTokens(pid).some((t) => t.startsWith("stacktake:"))).toBe(true);

    for (const d of [a, b, c])
      markDoseTaken(pid, d.doseId, d.itemId, today(pid), "page");

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
  });

  // RE-OFFERING THE SAME BUNDLE IS A READ. The stack button is re-derived on every
  // render, so a mint that allocated a fresh row each time would move the token every
  // tick — and a keyboard that differs is a keyboard the sweep EDITS, which is the
  // zero-call steady state gone and a `notify_offers` row per tick besides.
  it("re-rendering a stack re-uses its offer, so a quiet tick stays quiet", async () => {
    const pid = newProfile("Steady Stan");
    const a = seedDose(pid, "Stan A", "AM stack");
    const b = seedDose(pid, "Stan B", "AM stack");
    seedDose(pid, "Stan C");
    seedLoginTelegram(pid, "5553283");
    await sendMorningReminder(pid);

    const offerRows = () =>
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM notify_offers WHERE profile_id = ?`
          )
          .get(pid) as { n: number }
      ).n;
    const parts = slotSessionForKeyboard(
      pid,
      [a.doseId, b.doseId],
      [],
      today(pid)
    );
    const stackToken = () =>
      renderDoseSession(pid, parts, today(pid)).actions!.find((x) =>
        x.data?.startsWith("stacktake:")
      )!.data;

    const first = stackToken();
    expect(first).toBeDefined();
    for (let i = 0; i < 4; i++) expect(stackToken()).toBe(first);
    expect(offerRows()).toBe(1);

    // And the sweep, which re-renders the same keyboard, sends nothing.
    const out = await reconcileProfileMessages(pid);
    expect([out.edited, out.closed]).toEqual([0, 0]);
    expect(liveTokens(pid)).toContain(first);
  });

  // AN OFFER ID IS NEVER REISSUED. The id is the entire token, and the row is pruned
  // on the same 3-day horizon that retires the message pointer, so a recycled rowid
  // hands a stale button someone else's bundle at exactly the moment the sweep can no
  // longer retire it. AUTOINCREMENT (20260827-notify-offers-autoincrement) is what
  // makes that impossible; delete the migration and this reds.
  it("a pruned offer's id is never handed to a later offer", async () => {
    const pid = newProfile("Recycle Rita");
    const a = seedDose(pid, "Rita A", "AM stack");
    const b = seedDose(pid, "Rita B", "AM stack");
    const first = mintOffer(pid, STACK_OFFER_FAMILY, today(pid), {
      doseIds: [a.doseId],
    });

    db.prepare(`DELETE FROM notify_offers WHERE profile_id = ?`).run(pid);

    const second = mintOffer(pid, STACK_OFFER_FAMILY, today(pid), {
      doseIds: [b.doseId],
    });
    expect(second).not.toBe(first);
  });

  it("a SKIP resolves the claim exactly like a take (#232)", async () => {
    const pid = newProfile("Skip Sasha");
    const { itemId, doseId } = seedDose(pid, "Sasha D3");
    seedLoginTelegram(pid, "5551784");
    await sendMorningReminder(pid);

    markDoseSkipped(pid, doseId, itemId, today(pid), "page");
    const out = await reconcileProfileMessages(pid);
    expect(out.closed).toBe(1);
  });

  it("PARTIAL resolution strips only the resolved buttons and keeps the rest live", async () => {
    const pid = newProfile("Partial Perry");
    const a = seedDose(pid, "Perry A");
    const b = seedDose(pid, "Perry B");
    seedLoginTelegram(pid, "5551785");
    await sendMorningReminder(pid);

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
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

describe("a PRN administration spends its redose window", () => {
  it("orders redose windows by administration time, not capture time", () => {
    const pid = newProfile("Redose clock");
    const { itemId, doseId } = seedPrnMedication(pid, "Clock Ibuprofen");
    const insert = db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, occurred_at, status)
       VALUES (?, ?, ?, '200 mg', ?, ?, 'taken')`
    );
    const armingId = Number(
      insert.run(
        doseId,
        itemId,
        today(pid),
        "2026-08-15T12:00:00Z",
        "2026-08-15T10:00:00Z"
      ).lastInsertRowid
    );
    insert.run(
      doseId,
      itemId,
      today(pid),
      "2026-08-15T11:00:00Z",
      "2026-08-15T11:00:00Z"
    );

    expect(redoseWindowState(pid, itemId, armingId)).toBe("superseded");
  });

  it("closes the old redose button when a newer dose is logged in the app", async () => {
    const pid = newProfile("Redose Rina");
    const { itemId, doseId } = seedPrnMedication(pid, "Rina Ibuprofen");
    seedLoginTelegram(pid, "5551789");
    const armingId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_logs
             (dose_id, item_id, date, amount, recorded_at, status)
           VALUES (?, ?, ?, '200 mg', ?, 'taken')`
        )
        .run(
          doseId,
          itemId,
          today(pid),
          utcSqlString(new Date(Date.now() - 7 * 3_600_000))
        ).lastInsertRowid
    );
    recordMessagePointer({
      profileId: pid,
      chatId: "5551789",
      messageId: 1789,
      kind: "redose",
      date: today(pid),
      title: "💊 Redose window open: Rina Ibuprofen",
      keyboard: [
        [
          {
            text: "💊 Log dose",
            callback_data: `redose:${pid}:${itemId}:${armingId}:nonce`,
          },
        ],
      ],
    });

    expect(logAdministration(pid, itemId, "page").kind).toBe("logged");
    expect(redoseWindowState(pid, itemId, armingId)).toBe("superseded");
    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain("dose logged.");
    expect(liveMessagePointers(pid)).toHaveLength(0);
  });

  it("closes an undone opening dose as cancelled even when an older dose remains", async () => {
    const pid = newProfile("Redose Undo");
    const { itemId, doseId } = seedPrnMedication(pid, "Undo Ibuprofen");
    seedLoginTelegram(pid, "5551791");
    const insert = db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, amount, recorded_at, status)
       VALUES (?, ?, ?, '200 mg', ?, 'taken')`
    );
    insert.run(
      doseId,
      itemId,
      today(pid),
      utcSqlString(new Date(Date.now() - 8 * 3_600_000))
    );
    const armingId = Number(
      insert.run(
        doseId,
        itemId,
        today(pid),
        utcSqlString(new Date(Date.now() - 7 * 3_600_000))
      ).lastInsertRowid
    );
    recordMessagePointer({
      profileId: pid,
      chatId: "5551791",
      messageId: 1791,
      kind: "redose",
      date: today(pid),
      title: "💊 Redose window open: Undo Ibuprofen",
      keyboard: [
        [
          {
            text: "💊 Log dose",
            callback_data: `redose:${pid}:${itemId}:${armingId}:nonce`,
          },
        ],
      ],
    });

    db.prepare("DELETE FROM intake_item_logs WHERE id = ?").run(armingId);
    expect(redoseWindowState(pid, itemId, armingId)).toBe("cancelled");
    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      "opening dose no longer logged."
    );
  });

  it("retires already-delivered legacy redose buttons that have no window id", async () => {
    const pid = newProfile("Legacy Redose");
    const { itemId } = seedPrnMedication(pid, "Legacy Ibuprofen");
    seedLoginTelegram(pid, "5551790");
    recordMessagePointer({
      profileId: pid,
      chatId: "5551790",
      messageId: 1790,
      kind: "redose",
      date: today(pid),
      title: "💊 Redose window open: Legacy Ibuprofen",
      keyboard: [
        [
          {
            text: "💊 Log dose",
            callback_data: `prn:${pid}:${itemId}:legacy`,
          },
        ],
      ],
    });

    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      "old action expired; use /dose to log."
    );
  });
});

describe("idempotence — the rate-limit pin", () => {
  it("costs no calls before a change or after that change settles", async () => {
    const pid = newProfile("Quiet Quill");
    const a = seedDose(pid, "Quill A");
    seedDose(pid, "Quill B");
    seedLoginTelegram(pid, "5551786");
    await sendMorningReminder(pid);

    const unchanged = await reconcileProfileMessages(pid);
    expect(unchanged.examined).toBe(1);
    expect(unchanged.edited).toBe(0);
    expect(unchanged.closed).toBe(0);
    expect(editKeyboard).not.toHaveBeenCalled();
    expect(editText).not.toHaveBeenCalled();

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
    expect((await reconcileProfileMessages(pid)).edited).toBe(1);
    editKeyboard.mockClear();
    editText.mockClear();

    const again = await reconcileProfileMessages(pid);
    expect(again.edited).toBe(0);
    expect(editKeyboard).not.toHaveBeenCalled();
    expect(editText).not.toHaveBeenCalled();
  });
});

describe("day rollover", () => {
  it("keeps yesterday's FOOD keyboard alive and closes one from OUTSIDE the window", async () => {
    // THIS TEST'S SUBJECT CHANGED SIDES AT #4118, so its old name is gone rather than
    // its assertion loosened. The food nudge used to be the sweep's example of a
    // rollover close — the token's date was read as the system's guess at when the user
    // ate, and the guess expired at midnight (#947). It no longer does: the handler
    // honours a tap on the message's own day for the same ±2 its dose neighbours use, so
    // closing at the rollover would delete buttons that still work, which is exactly the
    // asymmetry #4118 was filed about. What the sweep must still do is close a keyboard
    // from OUTSIDE that window, and both halves are asserted here on one fixture.
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

    // Inside the window: still live, still tappable.
    expect((await reconcileProfileMessages(pid)).closed).toBe(0);
    expect(liveMessagePointers(pid).map((p) => p.messageId)).toEqual([4242]);

    // A second pointer from three days back — the first day the handler refuses — is
    // the one the sweep still ends.
    const old = shiftDateStr(today(pid), -3);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551788",
      messageId: 4243,
      kind: "food",
      date: old,
      keyboard: [
        [
          {
            text: "🥬 Leafy greens",
            callback_data: `food:${pid}:Morning:${old}:leafy_greens`,
          },
        ],
        [
          {
            text: "➕ Show more",
            callback_data: `foodmore:${pid}:Morning:${old}`,
          },
        ],
      ],
    });
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(liveMessagePointers(pid).map((p) => p.messageId)).toEqual([4242]);
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
    expect(markDoseTaken(pid, doseId, itemId, D, "page")).toBe("logged");

    // Resolved for real now, so the message closes as HANDLED — not as out of date.
    // Since #2274 "handled" is the dose NAMED, in the domain's own word.
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toMatch(
      /Bea D3 taken \d\d:\d\d\.$/
    );
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
            text: "🗑️ Discard",
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

  it("rate limits and 5xx closes keep the same pointer retryable", async () => {
    const pid = newProfile("Blip Bella");
    const { itemId, doseId } = seedDose(pid, "Bella D3");
    seedLoginTelegram(pid, "5551885");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid), "page");
    const before = liveMessagePointers(pid)[0];

    editText
      .mockRejectedValueOnce(
        new TelegramApiError({
          method: "editMessageText",
          status: 429,
          description: "Too Many Requests: retry after 30",
          message:
            "Telegram editMessageText failed: Too Many Requests: retry after 30",
        })
      )
      .mockRejectedValueOnce(transientFailure());
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

    // A 5xx is classified the same way, then the next healthy tick closes it.
    expect((await reconcileProfileMessages(pid)).deferred).toBe(1);
    const third = await reconcileProfileMessages(pid);
    expect(third.closed).toBe(1);
    expect(third.deferred).toBe(0);
    expect(liveMessagePointers(pid)).toEqual([]);
    expect(editText).toHaveBeenCalledTimes(3);
  });

  it("a failed STRIP leaves the pointer describing what the chat still shows", async () => {
    const pid = newProfile("Blip Bruno");
    const a = seedDose(pid, "Bruno A");
    seedDose(pid, "Bruno B");
    seedLoginTelegram(pid, "5551886");
    await sendMorningReminder(pid);
    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");

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

  it("drops permanently dead blocked and missing messages", async () => {
    const cases: [string, string, Error][] = [
      [
        "Blocked Bo",
        "5551888",
        new TelegramApiError({
          method: "editMessageText",
          status: 403,
          description: "Forbidden: bot was blocked by the user",
          message:
            "Telegram editMessageText failed: Forbidden: bot was blocked by the user",
        }),
      ],
      [
        "Ghost Gil",
        "5551789",
        new Error("Telegram editMessageText failed: message to edit not found"),
      ],
    ];

    for (const [name, chat, error] of cases) {
      const pid = newProfile(name);
      const { itemId, doseId } = seedDose(pid, `${name} D3`);
      seedLoginTelegram(pid, chat);
      await sendMorningReminder(pid);
      markDoseTaken(pid, doseId, itemId, today(pid), "page");

      editText.mockRejectedValueOnce(error);
      const out = await reconcileProfileMessages(pid);
      expect(out.dropped).toBe(1);
      expect(out.deferred).toBe(0);
      expect(liveMessagePointers(pid)).toEqual([]);
    }
  });

  it("retries stay bounded by retention — a permanently failing pointer ages out", async () => {
    // The bound that lets "transient" mean retry without meaning retry FOREVER: the
    // restored row keeps its original sent_at, so the pruner still reaches it.
    const pid = newProfile("Bounded Bea");
    const { itemId, doseId } = seedDose(pid, "Bea D3");
    seedLoginTelegram(pid, "5551889");
    await sendMorningReminder(pid);
    markDoseTaken(pid, doseId, itemId, today(pid), "page");

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

    markDoseTaken(mine, m.doseId, m.itemId, today(mine), "page");
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
            text: "⏭️ Skipped",
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

    markDoseTaken(pid, doseId, itemId, td, "page");
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
            text: "✅ Ana",
            callback_data: `hh:${carer}:${wardA}:${a.doseId}:${a.itemId}:${td}`,
          },
        ],
        [
          {
            text: "✅ Bo",
            callback_data: `hh:${carer}:${wardB}:${b.doseId}:${b.itemId}:${td}`,
          },
        ],
      ],
    });

    // Ana's dose is confirmed in the app; Bo's is not.
    markDoseTaken(wardA, a.doseId, a.itemId, td, "page");
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
    setProfileBirthdate(pid, "1970-04-02");
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
    logFoodServingCore(
      pid,
      slug!,
      td,
      "page",
      new Date().toISOString(),
      "Morning"
    );

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
    setProfileBirthdate(pid, "1970-04-02");
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
    logFoodServingCore(
      pid,
      slug!,
      td,
      "page",
      new Date().toISOString(),
      "Morning"
    );
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

    markDoseTaken(pid, doseId, itemId, today(pid), "page");

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

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
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

  it("the stored witness allows exactly one keyboard update", async () => {
    // The regression this pins: the witness is the stored blob VERBATIM, never a
    // re-serialization. A round-trip that reordered a key would produce a witness that
    // never matches — and the sweep would silently stop editing anything, forever.
    const pid = newProfile("Witness Wren");
    seedDose(pid, "Wren D3");
    seedLoginTelegram(pid, "5551805");
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

  it("a close claim is profile-scoped and can win only once", async () => {
    const mine = newProfile("Mine Mabel");
    const theirs = newProfile("Theirs Tarek");
    seedDose(theirs, "Tarek D3");
    seedLoginTelegram(theirs, "5551808");
    await sendMorningReminder(theirs);

    const p = onePointer(theirs);
    expect(claimMessagePointerClose(mine, p.id, p.version)).toBe(false);
    expect(claimMessagePointerClose(theirs, p.id, p.version)).toBe(true);
    expect(claimMessagePointerClose(theirs, p.id, p.version)).toBe(false);
    expect(liveMessagePointers(theirs)).toEqual([]);
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
  // Attribution is `dispatch`'s (#4538), so the send is the plain built message and the
  // title the pointer stores is whatever the chokepoint composed — asked for here
  // through the same function rather than reproduced by hand.
  async function sendAttributedReminder(profileId: number): Promise<string> {
    const built = buildIntakeReminderForSlots(profileId, ["Morning"]);
    expect(built).not.toBeNull();
    await dispatch(profileId, built!.message);
    return composeForSend(profileId, built!.message).title;
  }

  it("records attributed titles and keeps shared-chat closes distinguishable", async () => {
    const shared = "5551991";
    const a = newProfile("Ada");
    const b = newProfile("Ben");
    const ad = seedDose(a, "Ada D3");
    const bd = seedDose(b, "Ben D3");
    seedLoginTelegram(a, shared);
    seedLoginTelegram(b, shared);
    const aTitle = await sendAttributedReminder(a);
    const bTitle = await sendAttributedReminder(b);
    expect(liveMessagePointers(a)[0]?.title).toBe(aTitle);
    expect(liveMessagePointers(b)[0]?.title).toBe(bTitle);

    markDoseTaken(a, ad.doseId, ad.itemId, today(a), "page");
    markDoseTaken(b, bd.doseId, bd.itemId, today(b), "page");
    editText.mockClear();
    await reconcileProfileMessages(a);
    await reconcileProfileMessages(b);

    const texts = editText.mock.calls.map((c) => String(c[2]));
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toBe(texts[1]);
    expect(
      texts.some((t) =>
        /^\[Ada\] 💊 Morning supplements — Ada D3 taken \d\d:\d\d\.$/.test(t)
      )
    ).toBe(true);
    expect(
      texts.some((t) =>
        /^\[Ben\] 💊 Morning supplements — Ben D3 taken \d\d:\d\d\.$/.test(t)
      )
    ).toBe(true);
  });

  it("names rollover subjects while legacy untitled pointers use the bare line", async () => {
    // THE VEHICLE CHANGED, NOT THE CLAIM. This used to ride a food keyboard, which
    // stopped producing a rollover close at #4118 when the food family moved onto the
    // dose window. `mood` is the exact-day family this is about now — a next-morning tap
    // on last night's face picker would answer yesterday's question — and the close TEXT
    // being asserted is unchanged.
    const pid = newProfile("Rollover Rhea");
    seedLoginTelegram(pid, "5551992");
    const yd = shiftDateStr(today(pid), -1);
    recordMessagePointer({
      profileId: pid,
      chatId: "5551992",
      messageId: 4343,
      kind: "mood",
      date: yd,
      keyboard: [[{ text: "🙂", callback_data: `mood:${pid}:4:${yd}` }]],
      title: "[Rhea] 🙂 How was today?",
    });
    // A pointer written before migration 139 — nothing to name, so nothing is invented.
    recordMessagePointer({
      profileId: pid,
      chatId: "5551992",
      messageId: 4444,
      kind: "mood",
      date: yd,
      keyboard: [[{ text: "🙂", callback_data: `mood:${pid}:4:${yd}` }]],
    });

    expect((await reconcileProfileMessages(pid)).closed).toBe(2);
    const texts = editText.mock.calls.map((c) => c[2]);
    expect(texts).toContain(
      "[Rhea] 🙂 How was today? — this was yesterday's message."
    );
    expect(texts).toContain(RECONCILE_CLOSING.rollover);
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

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
    markDoseTaken(pid, b.doseId, b.itemId, today(pid), "page");
    markDoseSkipped(pid, c.doseId, c.itemId, today(pid), "page");

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    const text = String(editText.mock.calls.at(-1)![2]);
    // One tap-all collapses to ONE timed clause; the skip carries no time (#2867).
    expect(text).toMatch(/Tara A, Tara B taken \d\d:\d\d · Tara C skipped\.$/);
    // The message's own subject still leads it (#1822 item 7) — attributed, because
    // `dispatch` composes the label onto every send now (#4538) and the close names the
    // title the pointer recorded at send time.
    expect(text.startsWith("[Tally Tara] 💊 Morning supplements —")).toBe(true);
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

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
    markDoseTaken(pid, b.doseId, b.itemId, today(pid), "page");

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toMatch(
      /Wren A, Wren B taken \d\d:\d\d\.$/
    );
  });

  // ---- …AND WHEN (#2867) ----
  //
  // The receipt reads the administration instants `getTakenDoseTimes` returns — stored
  // UTC, rendered in the PROFILE's timezone. Both facts are asserted against a stamped
  // instant rather than the wall clock, so the reading cannot pass by coincidence.
  it("states each administration time, in the profile's timezone", async () => {
    const pid = newProfile("Clock Cleo");
    setTimezone(pid, "America/New_York");
    const a = seedDose(pid, "Cleo A");
    const b = seedDose(pid, "Cleo B");
    const c = seedDose(pid, "Cleo C");
    const d = seedDose(pid, "Cleo D");
    seedLoginTelegram(pid, "5552867");
    await sendMorningReminder(pid);

    const date = today(pid);
    markDoseTaken(pid, a.doseId, a.itemId, date, "page");
    markDoseTaken(pid, b.doseId, b.itemId, date, "page");
    markDoseTaken(pid, c.doseId, c.itemId, date, "page");
    markDoseSkipped(pid, d.doseId, d.itemId, date, "page");
    // 12:12 UTC is 08:12 in New York — the whole point of formatting in the profile's
    // zone rather than the host's. A and B share the displayed minute; C is later.
    stampDoseTakenAt(pid, a.doseId, `${date} 12:12:04`);
    stampDoseTakenAt(pid, b.doseId, `${date} 12:12:51`);
    stampDoseTakenAt(pid, c.doseId, `${date} 15:45:00`);

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      "Cleo A, Cleo B taken 08:12 · Cleo C taken 11:45 · Cleo D skipped."
    );
  });

  // THE MIDNIGHT-CROSSING CORRECTION, end to end — and the multi-date qualifier with it.
  //
  // `restampDoseLogsCore` moves the stored instant and leaves the ADHERENCE DAY alone by
  // design (it reports `crossedMidnight` for exactly this), so a dose that belongs to
  // today can have been administered at 23:50 last night. Pairing the adherence day with
  // the instant's wall clock rendered "Aug 14, 23:50" for an instant that was Aug 13 —
  // a datetime that never happened.
  //
  // It also pins the DATE QUALIFIER at this tier, which nothing else did: the close now
  // spans two rendered dates, so both clauses must carry one.
  it("dates a corrected dose by the instant it names, not by its adherence day", async () => {
    const pid = newProfile("Crossing Cora");
    setTimezone(pid, "America/New_York");
    const a = seedDose(pid, "Cora A");
    const b = seedDose(pid, "Cora B");
    seedLoginTelegram(pid, "5552869");
    await sendMorningReminder(pid);

    const date = today(pid);
    markDoseTaken(pid, a.doseId, a.itemId, date, "page");
    markDoseTaken(pid, b.doseId, b.itemId, date, "page");
    // Both rows keep TODAY as their adherence date. 03:50Z on that date is 23:50 the
    // PREVIOUS evening in New York — the shape a correction back across midnight leaves.
    stampDoseTakenAt(pid, a.doseId, `${date} 03:50:00`);
    stampDoseTakenAt(pid, b.doseId, `${date} 12:12:00`);

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    const yesterday = shiftDateStr(date, -1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      `Cora A taken ${formatMonthDay(yesterday)}, 23:50 · ` +
        `Cora B taken ${formatMonthDay(date)}, 08:12.`
    );
  });

  it("falls back to the recorded instant for a row with no occurred_at", async () => {
    // The older-data shape: `occurred_at` postdates these rows, so the read COALESCEs
    // to `recorded_at`. The receipt states a time either way, and never guesses one.
    const pid = newProfile("Legacy Lena");
    setTimezone(pid, "America/New_York");
    const a = seedDose(pid, "Lena A");
    seedLoginTelegram(pid, "5552868");
    await sendMorningReminder(pid);

    const date = today(pid);
    markDoseTaken(pid, a.doseId, a.itemId, date, "page");
    stampDoseTakenAt(pid, a.doseId, `${date} 12:12:00`, null);

    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toContain(
      "Lena A taken 08:12."
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

    markDoseTaken(pid, a.doseId, a.itemId, today(pid), "page");
    await reconcileProfileMessages(pid);
    const closingText = String(editText.mock.calls.at(-1)![2]);
    expect(closingText).toMatch(/Sana A taken \d\d:\d\d\.$/);
    expect(liveMessagePointers(pid)).toEqual([]);

    // Correct it in the app afterwards…
    markDoseSkipped(pid, a.doseId, a.itemId, today(pid), "page");
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
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1), "page");

    const res = await reconcileProfileMessages(p);
    expect(res.edited).toBe(1);
    // The edit carries the CURRENT fraction — one computation, the same builder the send
    // ran, never a second renderer.
    const edited = String(editText.mock.calls[0][2]);
    expect(edited).toContain("1/1 taken");
    expect(edited).not.toContain("0/1 taken");
  });

  // ── THE DIGEST'S OWN TAP CORRECTS ITS OWN SENTENCES (#3933) ─────────────
  //
  // Both halves of the hole this closes live here, and one assertion sees both. The ⚙️
  // Tune toggle writes login display state, so it looked like a tap that owed no sweep —
  // but `digestDemotionsForProfile` feeds `gatherDigestInput`, so on a profile one login
  // manages it changes what the digest SAYS. And the sweep used to exclude the tapped
  // message on the grounds that its handler had just rebuilt it, which is false for this
  // whole class: `handleTuneTap` edits the KEYBOARD, and `syncMessagePointerKeyboard`
  // never touches `body_hash`. Either half alone leaves the digest asserting a Check-in
  // line under a 🔕 icon until the next tick — the hour the tap-time sweep exists to
  // remove.
  it("a ⚙️ Tune toggle rewrites the digest it was tapped on", async () => {
    const p = newProfile("Tune Tori");
    const chat = "9105";
    seedLoginTelegram(p, chat);
    const yd = shiftDateStr(today(p), -1);
    db.prepare(
      `INSERT INTO mood_logs (profile_id, date, valence, energy) VALUES (?, ?, 3, 3)`
    ).run(p, yd);
    await sendDigest(p, "Tune Tori");
    const [pointer] = liveMessagePointers(p);
    expect(String(pointer.kind)).toBe("digest");
    editText.mockClear();

    await handleCallbackQuery(
      tapCq(chat, pointer.messageId, tuneToggleToken(p, today(p), "mood"), [])
    );

    // The routine Check-in line the digest was still asserting is gone from the text
    // the reader now sees, in the same cycle as the tap.
    expect(editText).toHaveBeenCalledTimes(1);
    expect(String(editText.mock.calls[0][2])).not.toContain("Check-in");
    // …and the sweep settles: a second pass has nothing left to correct.
    expect((await reconcileProfileMessages(p)).edited).toBe(0);
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
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1), "page");

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
    markDoseTaken(p, doseId, itemId, shiftDateStr(today(p), -1), "page");

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
    expect(markDoseTaken(pid, doseId, itemId, today(pid), "page")).toBe(
      "logged"
    );
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
    markDoseTaken(pid, doseId, itemId, shiftDateStr(today(pid), -1), "page");

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

    markDoseTaken(pid, doseId, itemId, shiftDateStr(today(pid), -1), "page");

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

    markDoseTaken(subject, doseId, itemId, today(subject), "page");

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
        { text: "🗑️ Discard", callback_data: `wodiscard:${pid}:${id}` },
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
        { text: "🗑️ Discard", callback_data: `wodiscard:${pid}:${id}` },
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
    setProfileBirthdate(pid, "1980-01-01");
    setProfileSex(pid, "male");
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
      [{ text: "✅ Meditation", callback_data: `pdone:${pid}:${targetId}:n1` }]
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
    markDoseTaken(ada, adaDose.doseId, adaDose.itemId, today(ada), "page");
    markDoseSkipped(bo, boDose.doseId, boDose.itemId, today(bo), "page");
    const d = today(receiver);

    const text = await closeTextFor(
      receiver,
      "5552286",
      7012,
      "dose",
      "[Cam] 💊 Household doses — 2 due across 2 members",
      [
        {
          text: "✅ Ada · Ada D3",
          callback_data: `hh:${receiver}:${ada}:${adaDose.doseId}:${adaDose.itemId}:${d}`,
        },
        {
          text: "✅ Bo · Bo Iron",
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
    markDoseTaken(pid, doseId, itemId, d, "page");

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
          text: "⏭️ Skip",
          callback_data: `escskip:${pid}:${doseId}:${itemId}:${d}`,
        },
        {
          text: "👀 Seen",
          callback_data: `escack:${pid}:${doseId}:${itemId}:${d}`,
        },
      ]
    );
    expect(text).toMatch(
      /^\[Esme\] ⚠️ Missed dose — Esme D3 taken \d\d:\d\d\.$/
    );
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
    markDoseTaken(a, ad.doseId, ad.itemId, today(a), "page");
    markDoseTaken(b, bd.doseId, bd.itemId, today(b), "page");

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

    expect(aText).toMatch(
      /^\[Ann\] 💊 Morning — Ann Magnesium taken \d\d:\d\d\.$/
    );
    expect(aText).not.toContain("Ben");
    expect(bText).toMatch(
      /^\[Ben\] 💊 Morning — Ben Magnesium taken \d\d:\d\d\.$/
    );
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
    // A `mood` keyboard rather than a food one since #4118 — see "names the subject on
    // a ROLLOVER close too". The tail text under assertion is unchanged.
    recordMessagePointer({
      profileId: pid,
      chatId: "5552289",
      messageId: 7016,
      kind: "mood",
      date: yd,
      keyboard: [[{ text: "🙂", callback_data: `mood:${pid}:4:${yd}` }]],
      title: "[Tess] 🙂 How was today?",
    });
    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    expect(String(editText.mock.calls.at(-1)![2])).toBe(
      "[Tess] 🙂 How was today? — this was yesterday's message."
    );
  });
});

// ── The pointer tracks what a TAP put on screen ──────────────────────────────
//
// `recordMessagePointer` is a SEND-time record, and for a long time it was the only
// writer: a tap rebuilt the message and left the pointer describing the SEND's keyboard.
// The sweep reasons entirely from that blob, so it decided about buttons that were no
// longer there. Every case below goes through a real send, a REAL tap, and then the real
// sweep — the combination the rest of this file never made, which is why none of it
// failed while two live surfaces were being corrupted every hour.
describe("the pointer follows a callback edit, not just a send", () => {
  it("does not close a confirmed dose session while its correction row is live", async () => {
    // #2020's chips ride the reminder for an hour after a confirm. The sweep used to
    // read the SEND's take/skip tokens, find the dose resolved, conclude every claim was
    // dead and CLOSE — taking a live affordance with it, up to 59 minutes early, on the
    // one tier where the instant it corrects arms the PRN redose window.
    const pid = newProfile("Live Lena");
    const { itemId, doseId } = seedDose(pid, "Live D3");
    seedLoginTelegram(pid, "5552290");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];

    await handleCallbackQuery(
      tapCq(
        "5552290",
        ptr.messageId,
        `take:${pid}:${doseId}:${itemId}:${date}`,
        messageKeyboard(built.message)
      )
    );
    // The pointer now says what the chat says: the session resolved, and the correction
    // row is the whole keyboard.
    const afterTap = liveTokens(pid);
    expect(afterTap.some((t) => t.startsWith("take:"))).toBe(false);
    expect(afterTap.some((t) => t.startsWith("dosetimeat:"))).toBe(true);

    // Pin the audit stamp so the burst's hour is a fact rather than a race, then sweep
    // well inside it.
    db.prepare(
      `UPDATE intake_item_logs SET recorded_at = ?, occurred_at = ?
        WHERE dose_id = ?`
    ).run(instantNow(), instantNow(), doseId);
    editText.mockClear();
    const swept = await reconcileProfileMessages(pid);
    expect(swept.closed).toBe(0);
    expect(swept.edited).toBe(0);
    expect(liveTokens(pid).some((t) => t.startsWith("dosetimeat:"))).toBe(true);
  });

  it("keeps the taken supplement in the receipt after its correction row expires", async () => {
    const pid = newProfile("Receipt Rhea");
    const { itemId, doseId } = seedDose(pid, "Receipt D3");
    seedLoginTelegram(pid, "5552294");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];

    await handleCallbackQuery(
      tapCq(
        "5552294",
        ptr.messageId,
        `take:${pid}:${doseId}:${itemId}:${date}`,
        messageKeyboard(built.message)
      )
    );
    const afterTap = liveMessagePointers(pid)[0];
    expect(
      keyboardTokens(afterTap.keyboard).some((t) => t.startsWith("take:"))
    ).toBe(false);
    expect(
      keyboardTokens(afterTap.receiptKeyboard).some((t) =>
        t.startsWith("take:")
      )
    ).toBe(true);

    // Age the temporary correction affordance out. The ledger still says the dose was
    // taken, and the close must state that fact instead of falling back to the legacy
    // "handled in the app" sentence.
    db.prepare(
      `UPDATE intake_item_logs SET recorded_at = ?, occurred_at = ?
        WHERE dose_id = ?`
    ).run("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", doseId);
    editText.mockClear();
    expect((await reconcileProfileMessages(pid)).closed).toBe(1);
    const closingText = String(editText.mock.calls.at(-1)![2]);
    expect(closingText).toMatch(/Receipt D3 taken \d\d:\d\d\.$/);
    expect(closingText).not.toContain("handled in the app");
  });

  it("does not collapse a food nudge the user expanded", async () => {
    // #1807: the expansion is the user's current view, and the sweep may only ever
    // REDUCE what a chat claims — never change what it shows. It read the visible count
    // off the SEND's compact keyboard, so the first sweep after any content change put
    // "Show more" back in the box.
    const pid = newProfile("Wide Wren");
    seedLoginTelegram(pid, "5552291");
    setProfileFoodTelegram(pid, true);
    const date = today(pid);
    const nudge = buildFoodNudge(pid, "Evening", date)!;
    await dispatch(pid, nudge);
    const ptr = liveMessagePointers(pid)[0];
    const compact = countVisibleFoodButtons(ptr.keyboard);

    await handleCallbackQuery(
      tapCq(
        "5552291",
        ptr.messageId,
        `foodmore:${pid}:Evening:${date}`,
        messageKeyboard(nudge)
      )
    );
    const expanded = countVisibleFoodButtons(liveKeyboard(pid));
    expect(expanded).toBeGreaterThan(compact);

    // A serving logged elsewhere moves the button labels, which is what used to make the
    // sweep re-render — at the stale compact width.
    logFoodServingCore(pid, canonicalFoodGroup("leafy_greens")!, date, "page");
    await reconcileProfileMessages(pid);
    expect(countVisibleFoodButtons(liveKeyboard(pid))).toBe(expanded);
  });

  it("refuses an expired food view control without rebuilding", async () => {
    const pid = newProfile("Stale Sage");
    seedLoginTelegram(pid, "5552295");
    const old = shiftDateStr(today(pid), -3);
    const token = `foodmore:${pid}:Evening:${old}`;

    vi.mocked(answerCallbackQuery).mockClear();
    editText.mockClear();
    await handleCallbackQuery(
      tapCq("5552295", 77, token, [
        [{ text: "➕ Show more", callback_data: token }],
      ])
    );

    expect(vi.mocked(answerCallbackQuery).mock.calls.at(-1)?.[1]).toContain(
      old
    );
    expect(editText).not.toHaveBeenCalled();
  });

  it("costs zero Telegram calls on the tick after a tap", async () => {
    // The zero-call steady state this sweep exists to protect: a converged pointer means
    // the first tick after a tap has nothing to say, rather than spending a call
    // discovering that its own record was stale.
    const pid = newProfile("Quiet Quinn");
    const { itemId, doseId } = seedDose(pid, "Quiet Mg");
    seedLoginTelegram(pid, "5552292");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];
    await handleCallbackQuery(
      tapCq(
        "5552292",
        ptr.messageId,
        `skip:${pid}:${doseId}:${itemId}:${date}`,
        messageKeyboard(built.message)
      )
    );
    editText.mockClear();
    editKeyboard.mockClear();
    await reconcileProfileMessages(pid);
    expect(editText.mock.calls.length + editKeyboard.mock.calls.length).toBe(0);
  });

  it("forgets the pointer when a tap CLOSES the message", async () => {
    // Closing is forgetting — the sweep's own close arm says so, and a consumed message
    // makes no claim for a later tick to reconcile.
    const pid = newProfile("Gone Gus");
    seedLoginTelegram(pid, "5552293");
    const date = today(pid);
    const item = seedDose(pid, "Gone Zinc");
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];
    // Retire the item so the tap finds no session to rebuild and falls to the arm that
    // drops the tapped button. The row carries take AND skip, so the first tap leaves
    // one behind — and the pointer records exactly that, which is what the second tap
    // then reads its context off.
    db.prepare(`UPDATE intake_items SET active = 0 WHERE id = ?`).run(
      item.itemId
    );
    await handleCallbackQuery(
      tapCq(
        "5552293",
        ptr.messageId,
        `take:${pid}:${item.doseId}:${item.itemId}:${date}`,
        messageKeyboard(built.message)
      )
    );
    expect(liveTokens(pid)).toEqual([
      `skip:${pid}:${item.doseId}:${item.itemId}:${date}`,
    ]);

    await handleCallbackQuery(
      tapCq(
        "5552293",
        ptr.messageId,
        `skip:${pid}:${item.doseId}:${item.itemId}:${date}`,
        liveKeyboard(pid)
      )
    );
    expect(liveMessagePointers(pid)).toHaveLength(0);
  });
});

// ── A refusal on the intake tier must be DISMISSED, not glanced at ───────────
//
// "Every refusal is spoken" has always been the contract, because a silent ack reads as
// success and on the dose side success means the redose window has been told something
// about a controlled medication. A plain callback answer under-delivers on it: a top
// banner on a phone, but on Telegram Desktop a small tooltip that fades on its own. So
// the refusals carry `show_alert` — and only the refusals, because a modal spent on
// "Logged ✅" is how the one that matters stops being read.
describe("intake refusals are answered as an alert, successes are not", () => {
  const answerOpts = () =>
    vi.mocked(answerCallbackQuery).mock.calls.at(-1)?.[2];

  it("alerts a ✅ on a dose already marked skipped, but not an honest log", async () => {
    const pid = newProfile("Alert Ada");
    const { itemId, doseId } = seedDose(pid, "Alert D3");
    seedLoginTelegram(pid, "5552294");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const kb = messageKeyboard(built.message);
    const take = `take:${pid}:${doseId}:${itemId}:${date}`;

    vi.mocked(answerCallbackQuery).mockClear();
    await handleCallbackQuery(tapCq("5552294", 1, take, kb));
    // The button did what it said. No modal.
    expect(answerOpts()?.alert).toBeFalsy();

    // Now the #280 case: the dose stands as SKIPPED, so a ✅ writes nothing and the
    // answer has to contradict its own label.
    // The #280 state, written directly: the dose is already TAKEN from the tap above,
    // so `markDoseSkipped` would refuse it (`already-taken`) and change nothing. The
    // fixture is the standing skip that the next ✅ has to contradict.
    db.prepare(
      `UPDATE intake_item_logs SET status = 'skipped' WHERE dose_id = ?`
    ).run(doseId);
    vi.mocked(answerCallbackQuery).mockClear();
    await handleCallbackQuery(tapCq("5552294", 1, take, kb));
    expect(answerOpts()?.alert).toBe(true);
  });

  it("does not alert a CARE-tier refusal either — the line is the intake tier", async () => {
    // A preventive tap whose rule is not in the catalog writes nothing, so it IS a
    // refusal — and it still answers as a toast. The boundary is deliberate and worth
    // pinning: it is not "refusals alert", it is "intake refusals alert", because the
    // harm the modal buys is a reader believing a medication was logged when it was not.
    const pid = newProfile("Toast Tam");
    seedLoginTelegram(pid, "5552296");
    vi.mocked(answerCallbackQuery).mockClear();
    await handleCallbackQuery(
      tapCq("5552296", 1, `pvdone:${pid}:not-a-real-rule-key`, [
        [
          {
            text: "✅ Done",
            callback_data: `pvdone:${pid}:not-a-real-rule-key`,
          },
        ],
      ])
    );
    expect(answerOpts()?.alert).toBeFalsy();
  });

  it("does not alert a food quick-log", async () => {
    // Coaching tier: a missed toast costs a serving's timestamp, and a modal here is
    // what would teach people to dismiss the dose one unread.
    const pid = newProfile("Calm Cato");
    seedLoginTelegram(pid, "5552295");
    setProfileFoodTelegram(pid, true);
    const date = today(pid);
    const nudge = buildFoodNudge(pid, "Evening", date)!;
    await dispatch(pid, nudge);
    const token = keyboardTokens(messageKeyboard(nudge)).find((t) =>
      t.startsWith("food:")
    )!;
    vi.mocked(answerCallbackQuery).mockClear();
    await handleCallbackQuery(
      tapCq("5552295", 1, token, messageKeyboard(nudge))
    );
    expect(answerOpts()?.alert).toBeFalsy();
  });
});

// ── THE TAP'S OWN SWEEP (#3933) ──────────────────────────────────────────────
//
// The tick's rule — "a message that keeps a stale button for another hour is bad, but a
// reconcile error that stops a medication reminder is worse" — is about failure
// isolation, and the tap inherits it verbatim: by the time the sweep runs the write has
// landed and the person has been answered, so a throw may cost the OTHER messages their
// correction and nothing else.
describe("a reconcile error never fails the tap (#3933)", () => {
  const CHAT = "5552293";

  afterEach(() => {
    tapSweepState.throwFor = null;
  });

  it("the write persists and the callback is still answered", async () => {
    const pid = newProfile("Isolated Ines");
    const { itemId, doseId } = seedDose(pid, "Isolated D3");
    seedLoginTelegram(pid, CHAT);
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];
    vi.mocked(answerCallbackQuery).mockClear();
    tapSweepState.throwFor = pid;

    await expect(
      handleCallbackQuery(
        tapCq(
          CHAT,
          ptr.messageId,
          `take:${pid}:${doseId}:${itemId}:${date}`,
          messageKeyboard(built.message)
        )
      )
    ).resolves.toBeUndefined();

    expect(
      (
        db
          .prepare(
            `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
          )
          .get(doseId, date) as { status: string } | undefined
      )?.status
    ).toBe("taken");
    expect(vi.mocked(answerCallbackQuery)).toHaveBeenCalledTimes(1);
    // …and the tapped message itself was still rebuilt: the sweep is the LAST thing the
    // tap does, so nothing ahead of it is lost.
    expect(liveTokens(pid).some((t) => t.startsWith("take:"))).toBe(false);
  });
});

// ── THE SWEEP IS BOUNDED ON THE WEBHOOK'S 200 PATH (#3951) ───────────────────
//
// The webhook awaits `handleCallbackQuery` before responding, and its own contract says
// it returns quickly so Telegram does not retry. #3933 made that call O(live pointers):
// pointers live MESSAGE_POINTER_RETENTION_DAYS, each edit is capped at
// TELEGRAM_CALL_TIMEOUT_MS, and nothing bounded the sweep as a whole
// (NOTIFICATION_DISPATCH_TIMEOUT_MS is a dispatch fan-out's bound and reconcile never
// reads it). Exceeding Telegram's webhook timeout makes it RE-DELIVER, and the whole
// tap re-runs including its write — a duplicate serving or administration in a person's
// health record, which is the worst thing on this path.
//
// TIME IS DRIVEN, NOT WAITED. `Date.now` is the only clock the budget reads (it is a
// duration, so lib/clock's date-derivation seam deliberately does not cover it), and
// each edit advances it by exactly the per-call cap the real transport enforces. So the
// arithmetic under test is the production arithmetic, and the test is deterministic on
// a box where four cores are shared — a wall-clock assertion here would be sampling
// contention rather than the bound.
describe("the tap sweep stops starting edits once its budget is spent (#3951)", () => {
  // N chats for one profile is N live pointers from one send — the fan-out the
  // pointer-recording block above already pins. Marking the dose taken in the app makes
  // every one of them stale, so each needs its own edit.
  async function staleInEveryChat(name: string, chats: string[]) {
    const pid = newProfile(name);
    const { itemId, doseId } = seedDose(pid, `${name} D3`);
    for (const c of chats) seedLoginTelegram(pid, c);
    await sendMorningReminder(pid);
    expect(liveMessagePointers(pid)).toHaveLength(chats.length);
    markDoseTaken(pid, doseId, itemId, today(pid), "page");
    return pid;
  }

  // Each edit costs a full call timeout — the degraded chat the budget exists for.
  function chargeEachEditOneCallTimeout(): () => void {
    let clock = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    editText.mockImplementation(async () => {
      clock += TELEGRAM_CALL_TIMEOUT_MS;
    });
    return () => {
      nowSpy.mockRestore();
      editText.mockImplementation(async () => {});
    };
  }

  const CHATS = ["5553951", "5553952", "5553953", "5553954", "5553955"];

  it.each([
    // The bound, and its converse in the same table: WITHOUT a budget the identical
    // fixture reconciles every pointer, so a green here cannot come from a sweep that
    // was never going to reach them anyway.
    {
      what: "a budget stops after the edit that spends it",
      budget: TAP_SWEEP_BUDGET_MS,
      examined: 1,
      unswept: CHATS.length - 1,
    },
    {
      what: "no budget reconciles every pointer, as the tick does",
      budget: undefined,
      examined: CHATS.length,
      unswept: 0,
    },
  ])("$what", async ({ what, budget, examined, unswept }) => {
    const pid = await staleInEveryChat(`Budget ${what.slice(0, 6)}`, CHATS);
    const restore = chargeEachEditOneCallTimeout();
    try {
      const out = await reconcileProfileMessages(pid, budget);
      expect({ examined: out.examined, unswept: out.unswept }).toEqual({
        examined,
        unswept,
      });
      // The bound is on STARTING work, so the one in flight still runs to completion:
      // the response is budget + one call, never pointers x one call.
      expect(editText).toHaveBeenCalledTimes(examined);
    } finally {
      restore();
    }
    // Nothing was DROPPED — an unswept pointer is untouched and the next tick takes it.
    expect(liveMessagePointers(pid)).toHaveLength(CHATS.length - examined);
  });

  it("derives the budget from one Bot API call, a constant this repo owns", () => {
    // Not a figure about Telegram's retry window, which would be a claim about someone
    // else's infrastructure wearing a comment. One call's budget admits at most two:
    // one started just under the deadline, plus the one already in flight.
    expect(TAP_SWEEP_BUDGET_MS).toBe(TELEGRAM_CALL_TIMEOUT_MS);
  });

  // WHAT THE TWO CASES ABOVE CANNOT SEE: they call the sweep themselves, so they stay
  // green on a tree where `handleCallbackQuery` has quietly stopped passing a budget —
  // which is the whole defect, since the tick is entitled to pass none. The bound has
  // to be asserted where the webhook actually spends it.
  it("is what the TAP path hands the sweep, not just what the sweep can accept", async () => {
    const pid = newProfile("Passed Pia");
    const { itemId, doseId } = seedDose(pid, "Pia D3");
    seedLoginTelegram(pid, "5553956");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];

    tapSweepState.swept = [];
    await handleCallbackQuery(
      tapCq(
        "5553956",
        ptr.messageId,
        `take:${pid}:${doseId}:${itemId}:${date}`,
        messageKeyboard(built.message)
      )
    );
    expect(tapSweepState.swept).toEqual([
      { profileId: pid, budgetMs: expect.any(Number) },
    ]);
    expect(tapSweepState.swept[0].budgetMs).toBeLessThanOrEqual(
      TAP_SWEEP_BUDGET_MS
    );
  });
});

// ── A WRITE THAT LANDS WITH A FAILED REBUILD KEEPS ITS SWEEP (#3951 F4) ──────
//
// Writing handlers run write → answer → `rebuildMessage`, and `rebuildMessage` ends in
// `editMessageTextRaw`, which throws on any Bot API failure. That throw exited
// `dispatchTap` before the sweep ran and the webhook swallowed it, leaving exactly the
// state the sweep exists for: the ledger moved, the person was told it moved, and now
// every live message is stale rather than one. A gap in new coverage, not a regression
// — before #3933 there was no sweep to lose.
//
// F5's budget lands first on purpose: `dispatchTap` throws almost only when the Bot API
// is degraded, so this adds a sweep to the very case that already threatened the
// webhook's timeout.
describe("a tap whose rebuild throws still sweeps (#3951)", () => {
  it("sweeps the chat's profile and lets the throw through", async () => {
    const pid = newProfile("Rebuild Rhea");
    const { itemId, doseId } = seedDose(pid, "Rhea D3");
    seedLoginTelegram(pid, "5553960");
    const date = today(pid);
    const built = buildIntakeReminderForSlots(pid, ["Morning"])!;
    await dispatch(pid, built.message);
    const ptr = liveMessagePointers(pid)[0];

    tapSweepState.swept = [];
    // Every edit from here fails — the degraded-chat shape. The write and the answer
    // both land first, so this is a rebuild throw and nothing else.
    editText.mockImplementation(async () => {
      throw new TelegramApiError({
        method: "editMessageText",
        status: 502,
        description: null,
        message: "Telegram editMessageText failed: HTTP 502",
      });
    });
    try {
      await expect(
        handleCallbackQuery(
          tapCq(
            "5553960",
            ptr.messageId,
            `take:${pid}:${doseId}:${itemId}:${date}`,
            messageKeyboard(built.message)
          )
        )
      ).rejects.toThrow("HTTP 502");
    } finally {
      editText.mockImplementation(async () => {});
    }

    // The write really did land — otherwise "the sweep was lost" would be describing a
    // tap that did nothing, and there would be nothing stale to reconcile.
    expect(
      (
        db
          .prepare(
            `SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?`
          )
          .get(doseId, date) as { status: string } | undefined
      )?.status
    ).toBe("taken");
    // And the sweep ran for this chat's profile despite the throw — under a budget, so
    // the recovery cannot be the thing that blows the webhook's timeout.
    expect(tapSweepState.swept).toEqual([
      { profileId: pid, budgetMs: expect.any(Number) },
    ]);
    expect(tapSweepState.swept[0].budgetMs).toBeLessThanOrEqual(
      TAP_SWEEP_BUDGET_MS
    );
  });
});
