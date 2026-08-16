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

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { stubTelegramSends } from "./telegram-spies";

import { db, today } from "@/lib/db";
import { setTelegramBotConfig, setTimezone } from "@/lib/settings";
import { handleCallbackQuery } from "@/lib/notifications/telegram-callbacks";
import { answerCallbackQuery } from "@/lib/notifications/telegram-api";
import { now as clockNow } from "@/lib/clock";
import { zonedDateParts, zonedWallTimeToUtc } from "@/lib/date";
import {
  getPracticeCorrectionBursts,
  getRecentPracticeTaps,
  logPracticeByTargetId,
  logPracticeSession,
} from "@/lib/queries";
import { restampPracticeLogsCore } from "@/lib/practice-log";
import { inferPracticeSchedule } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import { PRACTICE_TIME_PREFIXES } from "@/lib/notifications/correction-rows";
import {
  messagePointerIdAt,
  recordMessagePointer,
} from "@/lib/notifications/message-pointers";
import { seedLoginTelegram } from "./fixtures";

beforeAll(() => stubTelegramSends());

const answer = vi.mocked(answerCallbackQuery);

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
    expect(String(answer.mock.calls.at(-1)?.[1] ?? "")).toMatch(/Couldn't find/);
  });
});
