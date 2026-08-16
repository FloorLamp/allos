// DB INTEGRATION TIER (#2875) — practice-time correction, the third domain.
//
// The harm this pins shut is NOT a display bug. `logPracticeSession` stamps `time` with
// the profile-local instant of the tap whenever a caller omits one, which every one-tap
// path does, and nothing in the chat could move it. That column then feeds the scheduler
// that produced the tap: `modalHour()` picks each practice's typical session hour and
// #2188's retimed pace nudge fires at it, so a sauna at 19:00 acknowledged at 21:30
// teaches the inference 21:00, which fires the next nudge later, which is acknowledged
// later still. The error compounds, and it degrades exactly the feature whose stated
// purpose is "today is usually a red-light day, at about this time".
//
// So the load-bearing case here is the SCHEDULER one: correct a burst, then read the
// inference back. A test that only asserted the rendered label would pass on a fix that
// changed nothing the nudge reads.

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
import {
  getPublicUrl,
  setPublicUrl,
  setTelegramBotConfig,
  setTimezone,
} from "@/lib/settings";
import { dispatch } from "@/lib/notifications";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import {
  answerCallbackQuery,
  editMessageTextRaw,
} from "@/lib/notifications/telegram-api";
import { reconcileProfileMessages } from "@/lib/notifications/reconcile";
import { keyboardTokens } from "@/lib/notifications/reconcile-core";
import { liveMessagePointers } from "@/lib/notifications/message-pointers";
import {
  behindPractices,
  buildPracticeReminder,
  practiceNudgeTimingNow,
} from "@/lib/notifications/practices";
import { now as clockNow } from "@/lib/clock";
import {
  shiftDateStr,
  utcSqlString,
  zonedDateParts,
  zonedWallTimeToUtc,
} from "@/lib/date";
import {
  getPracticeCorrectionBursts,
  getRecentPracticeTaps,
  logPracticeByTargetId,
  logPracticeSession,
} from "@/lib/queries";
import { restampPracticeLogsCore } from "@/lib/practice-log";
import { inferPracticeSchedule } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import {
  correctableBursts,
  correctionActions,
  correctionOffScopeStatement,
  correctionPickerActions,
  PRACTICE_TIME_PREFIXES,
} from "@/lib/notifications/correction-rows";
import {
  chipTarget,
  offeredHours,
  parseCorrectionAtToken,
  parseCorrectionChipToken,
  pickerHourOptions,
  statedHourInstant,
} from "@/lib/correction-time";
import {
  messagePointerIdAt,
  recordMessagePointer,
} from "@/lib/notifications/message-pointers";
import { seedLoginTelegram } from "./fixtures";

beforeAll(() => stubTelegramSends());

const answer = vi.mocked(answerCallbackQuery);
const editText = vi.mocked(editMessageTextRaw);

function makeProfile(name: string, tz = "Europe/Berlin"): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, tz);
  return id;
}

function practiceTarget(profileId: number, name: string, floor = 3): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week)
         VALUES (?, 'practice', ?, ?, ?)`
      )
      .run(profileId, name, practiceIdentity(name), floor).lastInsertRowid
  );
}

function storedTime(logId: number): string | null {
  return (
    db.prepare("SELECT time FROM practice_logs WHERE id = ?").get(logId) as {
      time: string | null;
    }
  ).time;
}

function storedDate(logId: number): string {
  return (
    db.prepare("SELECT date FROM practice_logs WHERE id = ?").get(logId) as {
      date: string;
    }
  ).date;
}

function lastLogId(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT id FROM practice_logs WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId) as { id: number }
  ).id;
}

beforeEach(() => {
  answer.mockClear();
});

describe("a practice tap can be re-timed", () => {
  it("moves the stored HH:MM back by a chip, and repeat taps compose", () => {
    const pid = makeProfile("chip");
    logPracticeSession(pid, "Sauna", today(pid));
    const id = lastLogId(pid);
    const before = storedTime(id);
    expect(before).toMatch(/^\d{2}:\d{2}$/);

    const bursts = getPracticeCorrectionBursts(pid, clockNow());
    expect(bursts).toHaveLength(1);

    // A chip counts back from the instant the ledger CURRENTLY holds, so two taps of
    // −30m mean an hour back rather than landing on the same minute (#2206).
    for (const step of [1, 2]) {
      const out = restampPracticeLogsCore(pid, bursts[0].fromId, (row) => {
        const at = new Date(row.statedAt ?? row.tapAt);
        return new Date(at.getTime() - 30 * 60_000);
      });
      expect(out, `step ${step}`).toEqual({ kind: "restamped", count: 1 });
    }

    const tz = "Europe/Berlin";
    const expected = zonedDateParts(
      tz,
      new Date(
        zonedWallTimeToUtc(tz, today(pid), before!)!.getTime() - 60 * 60_000
      )
    ).hhmm;
    expect(storedTime(id)).toBe(expected);
    // The DAY is untouched: the chips move a time within a day.
    expect(storedDate(id)).toBe(today(pid));
  });

  it("re-stamps every row of a burst, since burst-mates share one error", () => {
    const pid = makeProfile("burst");
    logPracticeSession(pid, "Breathwork", today(pid));
    logPracticeSession(pid, "Cold plunge", today(pid));
    const ids = db
      .prepare("SELECT id FROM practice_logs WHERE profile_id = ? ORDER BY id")
      .all(pid) as { id: number }[];
    expect(ids).toHaveLength(2);

    const [burst] = getPracticeCorrectionBursts(pid, clockNow());
    expect(burst.count).toBe(2);
    const out = restampPracticeLogsCore(pid, burst.fromId, (row) => {
      const at = new Date(row.statedAt ?? row.tapAt);
      return new Date(at.getTime() - 60 * 60_000);
    });
    expect(out).toEqual({ kind: "restamped", count: 2 });
  });
});

describe("the corrected time is what the scheduler reads", () => {
  // THE ACCEPTANCE CASE. `modalHour()` picks the practice's typical hour from the
  // stored `time` column, and #2188's retimed nudge fires at it. A fix that corrected
  // only the display would leave this assertion at the tap hour.
  it("moves the inferred typical hour with the correction", () => {
    const pid = makeProfile("rhythm");
    const tz = "Europe/Berlin";
    const t = today(pid);

    // A habit whose sessions were all acknowledged LATE, at 21:00 — the compounding
    // shape the issue describes. Inserted directly: the write core rightly refuses
    // dates this old, and the inference reads the store.
    const weekday = new Date(`${t}T00:00:00Z`).getUTCDay();
    for (let w = 1; w <= 4; w++) {
      const d = new Date(`${t}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 7 * w);
      db.prepare(
        `INSERT INTO practice_logs (profile_id, practice, date, time)
         VALUES (?, 'Sauna', ?, '21:00')`
      ).run(pid, d.toISOString().slice(0, 10));
    }
    expect(weekday).toBeGreaterThanOrEqual(0);
    expect(inferPracticeSchedule(pid, "Sauna").hour).toBe(21);

    // Now correct every one of those rows to 19:00 — what the sessions actually were.
    db.prepare(
      `UPDATE practice_logs SET time = '19:00' WHERE profile_id = ? AND practice = 'Sauna'`
    ).run(pid);
    expect(
      inferPracticeSchedule(pid, "Sauna").hour,
      "modalHour reads practice_logs.time, so a corrected burst must move the " +
        "typical hour the retimed nudge fires at (#2188)"
    ).toBe(19);
    expect(tz).toBe("Europe/Berlin");
  });

  it("a chip correction is visible to the inference, end to end", () => {
    const pid = makeProfile("rhythm-live");
    const t = today(pid);
    logPracticeSession(pid, "Journaling", t);
    const id = lastLogId(pid);
    const tapped = storedTime(id)!;

    const [burst] = getPracticeCorrectionBursts(pid, clockNow());
    restampPracticeLogsCore(pid, burst.fromId, (row) => {
      const at = new Date(row.statedAt ?? row.tapAt);
      return new Date(at.getTime() - 60 * 60_000);
    });
    const corrected = storedTime(id)!;
    expect(corrected).not.toBe(tapped);
    // One row is the whole ledger here, so the modal hour IS this row's hour.
    expect(inferPracticeSchedule(pid, "Journaling").hour).toBe(
      Number(corrected.slice(0, 2))
    );
  });
});

describe("a null time is a decision, not a gap", () => {
  it("never appears in a burst and is never given a time by a chip", () => {
    const pid = makeProfile("nulltime");
    // The expanded form's explicit "no instant" statement.
    logPracticeSession(pid, "Meditation", today(pid), { time: null });
    const untimed = lastLogId(pid);
    expect(storedTime(untimed)).toBeNull();

    expect(getRecentPracticeTaps(pid, clockNow())).toEqual([]);
    expect(getPracticeCorrectionBursts(pid, clockNow())).toEqual([]);

    // Even anchored directly on that row's id, the write core refuses: the re-read
    // excludes null-time rows, so there is no burst to move.
    const out = restampPracticeLogsCore(pid, untimed, () => new Date());
    expect(out).toEqual({ kind: "no-burst" });
    expect(storedTime(untimed)).toBeNull();
  });

  it("a timed sibling's chip does not sweep an untimed row up with it", () => {
    const pid = makeProfile("nulltime-sibling");
    const t = today(pid);
    logPracticeSession(pid, "Meditation", t, { time: null });
    const untimed = lastLogId(pid);
    logPracticeSession(pid, "Sauna", t);
    const timed = lastLogId(pid);

    const [burst] = getPracticeCorrectionBursts(pid, clockNow());
    expect(burst.ids).toEqual([timed]);
    restampPracticeLogsCore(pid, burst.fromId, (row) => {
      const at = new Date(row.statedAt ?? row.tapAt);
      return new Date(at.getTime() - 30 * 60_000);
    });
    expect(storedTime(untimed)).toBeNull();
    expect(storedTime(timed)).not.toBeNull();
  });
});

describe("the chips never move a session to another day", () => {
  it("refuses rather than clamping when the answer crosses local midnight", () => {
    const pid = makeProfile("midnight");
    const tz = "Europe/Berlin";
    const t = today(pid);
    logPracticeSession(pid, "Cold plunge", t);
    const id = lastLogId(pid);
    const before = storedTime(id)!;

    const [burst] = getPracticeCorrectionBursts(pid, clockNow());
    // Aim at 30 minutes BEFORE local midnight of the row's own day — always the
    // previous day, whatever hour the suite is running at.
    const target = new Date(
      zonedWallTimeToUtc(tz, t, "00:00")!.getTime() - 30 * 60_000
    );
    const out = restampPracticeLogsCore(pid, burst.fromId, () => target);
    expect(out).toEqual({ kind: "crosses-day" });
    // ALL-OR-NOTHING, and nothing is what happened.
    expect(storedTime(id)).toBe(before);
    expect(storedDate(id)).toBe(t);
  });
});

describe("date + time compose through the profile's timezone", () => {
  // #450: the composition is server-side and zone-aware. A naive `${date}T${time}`
  // would read host-UTC and put the instant on the wrong side of a day boundary in
  // every zone but UTC.
  for (const tz of ["Pacific/Auckland", "America/Los_Angeles"]) {
    it(`round-trips a stored HH:MM in ${tz}`, () => {
      const pid = makeProfile(`tz-${tz}`, tz);
      const t = today(pid);
      for (const hhmm of ["00:15", "23:45", "12:00"]) {
        db.prepare(
          `INSERT INTO practice_logs (profile_id, practice, date, time)
           VALUES (?, 'Sauna', ?, ?)`
        ).run(pid, t, hhmm);
        const id = lastLogId(pid);
        // The composition the tap reader performs, decomposed again by the writer's
        // own inverse. Both halves must agree or a chip would silently shift a session
        // by the zone offset.
        const composed = zonedWallTimeToUtc(tz, t, hhmm)!;
        const back = zonedDateParts(tz, composed);
        expect(back.hhmm, `${tz} ${hhmm}`).toBe(hhmm);
        expect(back.date, `${tz} ${hhmm}`).toBe(t);
        expect(storedTime(id)).toBe(hhmm);
      }
    });
  }
});

describe("a burst renders only on the message that produced it (#2264)", () => {
  it("stamps the originating message on a nudge tap and binds the burst to it", async () => {
    const pid = makeProfile("binding");
    setTelegramBotConfig({
      telegramBotToken: "bot for tests 12",
      telegramMode: "poll",
    });
    seedLoginTelegram(pid, "5552875");
    const targetId = practiceTarget(pid, "Sauna");

    // The write path carries the pointer through, which is what the binding reads.
    logPracticeByTargetId(pid, targetId, null);
    const unattributed = lastLogId(pid);
    expect(
      (
        db
          .prepare(
            "SELECT notify_message_id AS m FROM practice_logs WHERE id = ?"
          )
          .get(unattributed) as { m: number | null }
      ).m
    ).toBeNull();

    // A stamped row reports its message on the tap row the offer reads. The pointer is
    // recorded through the real store, so the id is the one production would stamp.
    recordMessagePointer({
      profileId: pid,
      chatId: "5552875",
      messageId: 4210,
      kind: "practice",
      date: today(pid),
      keyboard: [],
    });
    const messageRow = messagePointerIdAt(pid, "5552875", 4210)!;
    expect(messageRow).toBeGreaterThan(0);
    logPracticeByTargetId(pid, targetId, messageRow);
    const attributed = lastLogId(pid);

    const taps = getRecentPracticeTaps(pid, clockNow());
    const byId = new Map(taps.map((t) => [t.id, t]));
    expect(byId.get(attributed)?.messageRef).toBe(messageRow);
    expect(byId.get(unattributed)?.messageRef).toBeNull();

    // A message that is NOT the one the tap came from, and is not the newest live
    // message of its domain, carries neither burst.
    expect(
      getPracticeCorrectionBursts(pid, clockNow(), {
        messageRef: messageRow + 999,
        isNewest: false,
      })
    ).toEqual([]);
  });

  it("mints tokens under the practice prefixes", () => {
    // The vocabulary is the extension; everything else is the shared substrate.
    expect(PRACTICE_TIME_PREFIXES.chip).toBe("practime");
    expect(PRACTICE_TIME_PREFIXES.at).toBe("practimeat");
  });
});

describe("an imported session is not a tap", () => {
  it("is excluded from the correction offer", () => {
    const pid = makeProfile("imported");
    db.prepare(
      `INSERT INTO practice_logs
         (profile_id, practice, date, time, source, external_id)
       VALUES (?, 'Sauna', ?, '19:00', 'oura', 'sauna row 7')`
    ).run(pid, today(pid));
    // Its `created_at` is when the SYNC ran, which would otherwise make a freshly
    // imported history look like a burst somebody just tapped.
    expect(getRecentPracticeTaps(pid, clockNow())).toEqual([]);
  });
});

// ---- The message lifecycle the chips ride ----------------------------------
//
// Everything above is about the WRITE. These are about the message: what the chat shows
// after a tap, and what takes it down again. All four defects here shipped green because
// no case followed a real nudge from send → tap → sweep.
describe("the pace nudge's correction lifecycle, end to end", () => {
  // A Tuesday, 08:00 in Berlin — inside the default waking window (08:00–21:00), and
  // the same weekday the #2188 rhythm cases use, so a Wed/Fri habit is HELD here.
  const NOW_ISO = "2026-06-16T06:00:00Z";
  let priorNow: string | undefined;

  beforeEach(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = NOW_ISO;
    setTelegramBotConfig({
      telegramBotToken: "bot for tests 12",
      telegramMode: "poll",
    });
    editText.mockClear();
  });

  afterEach(() => {
    if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
    else process.env.ALLOS_TEST_NOW = priorNow;
    setPublicUrl("");
  });

  function setNow(iso: string): void {
    process.env.ALLOS_TEST_NOW = iso;
  }

  // History for the rhythm inference, stamped as if it were WRITTEN back then. A bare
  // insert takes SQLite's `created_at` default, i.e. the real clock, which would make
  // an eight-week fixture read as a burst somebody just tapped.
  function seedSessionOn(
    profileId: number,
    practice: string,
    date: string,
    time: string
  ): void {
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(profileId, practice, date, time, `${date} 12:00:00`);
  }

  // The delivered message, as Telegram hands it back on a tap.
  function tap(chatId: string, data: string, keyboard: unknown, messageId = 0) {
    return {
      id: `cb-${data}`,
      data,
      message: {
        message_id: messageId,
        chat: { id: Number(chatId) },
        text: "🌿 Practice check-in",
        reply_markup: { inline_keyboard: keyboard },
      },
    } as never;
  }

  function livePointer(profileId: number) {
    const [p] = liveMessagePointers(profileId);
    return p;
  }

  function urlButtons(keyboard: { url?: string }[][]): string[] {
    return keyboard.flat().flatMap((b) => (b.url ? [b.url] : []));
  }

  async function sendNudge(profileId: number) {
    const msg = buildPracticeReminder(
      profileId,
      "n1",
      getPublicUrl(),
      practiceNudgeTimingNow(profileId, clockNow())
    )!;
    expect(msg, "the fixture must actually produce a nudge").toBeTruthy();
    await dispatch(profileId, msg);
    return livePointer(profileId);
  }

  it("consumes the tapped ✓, keeps the sibling and the deep link, and grows the chips", async () => {
    const pid = makeProfile("lifecycle-tap");
    seedLoginTelegram(pid, "5552881");
    setPublicUrl("https://allos.example");
    // A DAILY floor, so one logged session leaves the practice still behind. That is
    // the case the consume claim is actually about: when the tap clears the shortfall
    // the button has no reason to exist and every implementation looks correct.
    const sauna = practiceTarget(pid, "Sauna", 7);
    const breath = practiceTarget(pid, "Breathwork");

    const pointer = await sendNudge(pid);
    const sent = keyboardTokens(pointer.keyboard);
    expect(sent).toContain(`pdone:${pid}:${sauna}:n1`);
    expect(sent).toContain(`pdone:${pid}:${breath}:n1`);
    expect(urlButtons(pointer.keyboard)).toEqual([
      "https://allos.example/wellness",
    ]);

    await handleCallbackQuery(
      tap(
        "5552881",
        `pdone:${pid}:${sauna}:n1`,
        pointer.keyboard,
        pointer.messageId
      )
    );

    // THE PREMISE, pinned: Sauna is at 1 of 7 and still behind, so live pace alone
    // would put its ✓ back. Without this the next assertion could pass vacuously.
    expect(behindPractices(pid).map((b) => b.targetId)).toContain(sauna);

    const after = livePointer(pid);
    const tokens = keyboardTokens(after.keyboard);
    // D1. The handler's own contract is that it "CONSUMES the tapped button so a stale
    // message can't double-log". Sauna is at 1 of 3 and therefore STILL BEHIND, so a
    // rebuild that re-derives from live pace alone hands the button straight back with
    // a fresh nonce — the tap looks like it did nothing.
    expect(
      tokens.filter((t) => t.startsWith(`pdone:${pid}:${sauna}:`)),
      "the tapped ✓ must not come back on the rebuild"
    ).toEqual([]);
    // The sibling was never tapped and stays usable. Matched on the TARGET, not on
    // the nonce: a rebuild re-mints per render, exactly as the food nudge's does.
    expect(tokens.some((t) => t.startsWith(`pdone:${pid}:${breath}:`))).toBe(
      true
    );
    // The reason the message rebuilds at all: the chips for the burst just created.
    expect(
      tokens.some((t) => t.startsWith(`${PRACTICE_TIME_PREFIXES.chip}:`))
    ).toBe(true);
    // D2. #1718's "affordance that survives everywhere" survived exactly until the
    // first tap, because the rebuild passed no deep-link base.
    expect(
      urlButtons(after.keyboard),
      "the rebuild must keep Open practices →"
    ).toEqual(["https://allos.example/wellness"]);
  });

  it("does not un-hold a rhythm-held practice on the rebuild (#2188)", async () => {
    const pid = makeProfile("lifecycle-hold");
    seedLoginTelegram(pid, "5552882");
    const redLight = practiceTarget(pid, "Red light therapy");
    const breath = practiceTarget(pid, "Breathwork");
    // Eight weeks of Wednesday+Friday sessions → a rhythm that holds on Tuesday.
    const t = today(pid);
    const sunday = shiftDateStr(t, -new Date(`${t}T00:00:00Z`).getUTCDay());
    for (let k = 1; k <= 8; k++)
      for (const wd of [3, 5])
        seedSessionOn(
          pid,
          "Red light therapy",
          shiftDateStr(sunday, -k * 7 + wd),
          "18:30"
        );

    // The SEND withholds it: Wednesday is still ahead this week.
    const pointer = await sendNudge(pid);
    const sent = keyboardTokens(pointer.keyboard);
    expect(sent).toContain(`pdone:${pid}:${breath}:n1`);
    expect(sent.some((x) => x.includes(`:${redLight}:`))).toBe(false);

    await handleCallbackQuery(
      tap(
        "5552882",
        `pdone:${pid}:${breath}:n1`,
        pointer.keyboard,
        pointer.messageId
      )
    );

    // D4. The rebuild used to fall through to the UNTIMED gather, which holds nothing,
    // so a redraw undid a suppression the send had applied.
    const tokens = keyboardTokens(livePointer(pid).keyboard);
    expect(
      tokens.filter((x) => x.includes(`:${redLight}:`)),
      "a redraw must apply the same #2188 hold the send applied"
    ).toEqual([]);
    // The BODY is where an un-held practice shows up first — it is listed there
    // whether or not it made the button cap, so this is the assertion that sees the
    // gather rather than the keyboard filter in front of it.
    const rebuiltText = String(editText.mock.calls.at(-1)?.[2] ?? "");
    expect(rebuiltText).not.toBe("");
    expect(
      rebuiltText,
      "the held practice must not be named by a message the send withheld it from"
    ).not.toContain("Red light therapy");
  });

  it("ages the chips out on the hour-long clock, then reconciles to zero (#2875)", async () => {
    const pid = makeProfile("lifecycle-sweep");
    seedLoginTelegram(pid, "5552883");
    const sauna = practiceTarget(pid, "Sauna");
    const breath = practiceTarget(pid, "Breathwork");

    const pointer = await sendNudge(pid);
    await handleCallbackQuery(
      tap(
        "5552883",
        `pdone:${pid}:${sauna}:n1`,
        pointer.keyboard,
        pointer.messageId
      )
    );
    expect(
      keyboardTokens(livePointer(pid).keyboard).some((t) =>
        t.startsWith(PRACTICE_TIME_PREFIXES.chip)
      )
    ).toBe(true);

    // Still fresh: the sweep has nothing to do, and does nothing.
    setNow("2026-06-16T06:30:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);

    // D3. `practice.dead()` never called `deadCorrectionTokens`, so the chips had NO
    // clock: this sweep — and the one an hour after it — edited nothing at all, and the
    // dead chips stood until the 3-day pointer prune, where a tap answers "Couldn't
    // find those entries any more".
    setNow("2026-06-16T08:00:00Z");
    const first = await reconcileProfileMessages(pid);
    expect(first.edited, "one trailing edit takes the lapsed chips off").toBe(
      1
    );
    const swept = keyboardTokens(livePointer(pid).keyboard);
    expect(swept.some((t) => t.startsWith("practime"))).toBe(false);
    // The untapped ✓ is a live claim and survives — only the chips lapsed.
    expect(swept.some((t) => t.startsWith(`pdone:${pid}:${breath}:`))).toBe(
      true
    );

    // THE IDEMPOTENCE PIN: the steady state costs zero Telegram calls.
    setNow("2026-06-16T10:00:00Z");
    expect((await reconcileProfileMessages(pid)).edited).toBe(0);
    expect(breath).toBeGreaterThan(0);
  });

  it("closes a nudge whose only remaining claims are lapsed chips", async () => {
    // The confirmation shape: ONE behind practice, tapped. Main closed that message on
    // the tap; the rebuild deliberately keeps it alive to carry the chips — so the
    // sweep has to be what closes it, and without a clock nothing ever did.
    const pid = makeProfile("lifecycle-close");
    seedLoginTelegram(pid, "5552884");
    const sauna = practiceTarget(pid, "Sauna");

    const pointer = await sendNudge(pid);
    await handleCallbackQuery(
      tap(
        "5552884",
        `pdone:${pid}:${sauna}:n1`,
        pointer.keyboard,
        pointer.messageId
      )
    );
    expect(liveMessagePointers(pid)).toHaveLength(1);

    setNow("2026-06-16T08:00:00Z");
    const result = await reconcileProfileMessages(pid);
    expect(result.closed, "every claim is dead — the message closes").toBe(1);
    expect(liveMessagePointers(pid)).toHaveLength(0);
    // And the close still NAMES what happened (#2275). The `pdone` token is long gone
    // from the LIVE keyboard by now, so a `detail` reading that keyboard would collapse
    // this to the bare sentence.
    const closingText = String(
      vi.mocked(editMessageTextRaw).mock.calls.at(-1)?.[2] ?? ""
    );
    expect(closingText).toMatch(/back on pace|done for the week/);
  });
});

describe("the callback dispatcher routes the practice prefixes", () => {
  it("refuses a token whose burst is not in the ledger, and writes nothing", async () => {
    const pid = makeProfile("dispatch");
    setTelegramBotConfig({
      telegramBotToken: "bot for tests 12",
      telegramMode: "poll",
    });
    seedLoginTelegram(pid, "5552876");
    await handleCallbackQuery({
      id: "cb 1",
      data: `${PRACTICE_TIME_PREFIXES.chip}:${pid}:999999:30`,
      message: {
        message_id: 8,
        chat: { id: 5552876 },
        reply_markup: { inline_keyboard: [] },
      },
    } as never);
    // The dispatcher reached the handler (a silent ack would mean the prefix fell
    // through to no route at all) and the handler spoke its refusal.
    expect(answer).toHaveBeenCalled();
    expect(String(answer.mock.calls.at(-1)?.[1] ?? "")).toMatch(
      /Couldn't find/
    );
  });
});

// ── THE RENDER HALF OF THE CROSS-MIDNIGHT REFUSAL (#2875) ────────────────────
//
// The refusal above is the WRITE half, and on its own it is a dead affordance: the
// chips and the picker are the shared, domain-blind ones, and THE DAY RULE they are
// built on (lib/correction-time.ts) resolves an offered hour LATER than the current
// local time to YESTERDAY. So every offer that rule re-dated was a button this core is
// guaranteed to refuse — at 00:20 local BOTH chips ("23:50 · −30m", "23:20 · −1h") and
// all eleven picker hours, which is 100% of the affordance dead in the hour the stored
// time is most wrong; on an ordinary morning still 4 dead picker buttons out of 11.
//
// This walks the OFFERED set through the REAL write core at every hour of the day. It
// is the round trip the two halves have to agree on, and only a keyboard bounded by the
// burst's own local day passes it.
describe("the keyboard never offers what the write core refuses (#2875)", () => {
  const TZ = "Europe/Berlin";
  const DAY = "2026-06-17"; // CEST, UTC+2 — the review's own reproduction day

  function atLocal(hhmm: string, date = DAY): Date {
    return zonedWallTimeToUtc(TZ, date, hhmm)!;
  }

  // A tap already on the ledger: its `created_at` is the instant its own day + time
  // compose to, which is what a real one-tap write produces.
  function seedTap(pid: number, hhmm: string, date = DAY): number {
    db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time, created_at)
         VALUES (?, 'Sauna', ?, ?, ?)`
    ).run(pid, date, hhmm, utcSqlString(atLocal(hhmm, date)));
    return lastLogId(pid);
  }

  // Every offer the practice keyboard actually carries at `now`, paired with the
  // `resolve` the matching handler would hand the write core.
  function offeredWrites(pid: number, now: Date) {
    const bursts = getPracticeCorrectionBursts(pid, now);
    const out: { label: string; resolve: Parameters<typeof restampPracticeLogsCore>[2]; fromId: number }[] = [];
    for (const a of correctionActions(PRACTICE_TIME_PREFIXES, pid, bursts, TZ, now)) {
      const chip = parseCorrectionChipToken(a.data, PRACTICE_TIME_PREFIXES.chip);
      if (chip)
        out.push({
          label: a.label,
          fromId: chip.fromId,
          resolve: (row) => chipTarget(row, chip.minutesBack, now),
        });
    }
    for (const burst of bursts) {
      for (const a of correctionPickerActions(
        PRACTICE_TIME_PREFIXES,
        pid,
        burst,
        now,
        TZ
      )) {
        const parsed = parseCorrectionAtToken(a.data, PRACTICE_TIME_PREFIXES.at);
        if (parsed?.step.kind !== "at") continue;
        const instant = statedHourInstant(parsed.step.hhmm, now, TZ);
        out.push({
          label: parsed.step.hhmm,
          fromId: burst.fromId,
          resolve: () => instant,
        });
      }
    }
    return out;
  }

  it("every offered chip and hour is one the core accepts, at every hour of the day", () => {
    const pid = makeProfile("render-half");
    for (const h of Array.from({ length: 24 }, (_, i) => i)) {
      const hhmm = `${String(h).padStart(2, "0")}:20`;
      const id = seedTap(pid, hhmm);
      const now = new Date(atLocal(hhmm).getTime() + 5 * 60_000);
      for (const offer of offeredWrites(pid, now)) {
        const outcome = restampPracticeLogsCore(pid, offer.fromId, offer.resolve);
        expect(outcome.kind, `${hhmm} local → "${offer.label}"`).toBe("restamped");
        expect(storedDate(id), `${hhmm} local → "${offer.label}"`).toBe(DAY);
        // Put the row back so the next offer starts from the same keyboard.
        db.prepare(
          "UPDATE practice_logs SET time = ?, edited = 0 WHERE id = ?"
        ).run(hhmm, id);
      }
      db.prepare("DELETE FROM practice_logs WHERE id = ?").run(id);
    }
  });

  it("draws no keyboard at all in the hour after local midnight, and says why", () => {
    const pid = makeProfile("after-midnight");
    seedTap(pid, "00:20");
    const now = new Date(atLocal("00:25").getTime());
    const bursts = getPracticeCorrectionBursts(pid, now);
    expect(bursts).toHaveLength(1);

    const { shown, offScope } = correctableBursts(
      PRACTICE_TIME_PREFIXES,
      bursts,
      now,
      TZ
    );
    expect(shown).toEqual([]);
    expect(offScope).toHaveLength(1);
    expect(correctionActions(PRACTICE_TIME_PREFIXES, pid, bursts, TZ, now)).toEqual([]);
    expect(correctionOffScopeStatement(offScope, TZ)).toBe(
      "🕐 Sauna — moving this would change its day — correct it in the app"
    );
  });

  it("keeps the ordinary morning's hours and drops exactly last night's four", () => {
    // The review's second reproduction: at 08:00 local the domain-blind picker offered
    // eleven hours and the core refused four of them — 23:00 back to 20:00, which THE
    // DAY RULE resolves onto yesterday.
    const pid = makeProfile("ordinary-morning");
    seedTap(pid, "08:00");
    const now = new Date(atLocal("08:25").getTime());
    const [burst] = getPracticeCorrectionBursts(pid, now);
    expect(pickerHourOptions(now, TZ)).toHaveLength(11);
    // Read off the KEYBOARD the practice picker actually renders, not off the helper.
    expect(
      correctionPickerActions(PRACTICE_TIME_PREFIXES, pid, burst, now, TZ).map(
        (a) => a.label
      )
    ).toEqual([
      "06:00",
      "05:00",
      "04:00",
      "03:00",
      "02:00",
      "01:00",
      "00:00",
      "↩︎ Back",
    ]);
    expect(offeredHours(burst, now, TZ, true)).toHaveLength(7);
    // And the chips — which count back from the STORED 08:00, not from now — are
    // untouched by the day bound.
    expect(
      correctionActions(PRACTICE_TIME_PREFIXES, pid, [burst], TZ, now).map(
        (a) => a.label
      )
    ).toEqual(["🕐 Sauna 08:00", "07:30 · −30m", "07:00 · −1h"]);
  });
});
