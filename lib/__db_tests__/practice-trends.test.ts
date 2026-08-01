// DB INTEGRATION TIER (issue #1632): the Trends wellness lens's read, end to end
// against the real schema.
//
// What it has to get right, and why each clause is a real regression class:
//
//   • The weekly VERDICTS are the practice domain's own — floor met / at ceiling /
//     under — so a week the /wellness card calls met can never read "under floor"
//     on Trends (#221).
//   • The in-progress week is absent. It is under its floor by construction on
//     every day but the last.
//   • Spellings fold onto ONE identity, exactly as every other practice read does.
//   • The duration series averages the sessions that actually carried minutes.
//   • An UNTRACKED practice has no range, so it is not in this lens at all.
//   • A window that ENDS IN THE PAST reads the weeks before its own end.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import { getPracticeTrends, logPracticeSession } from "@/lib/queries";
import { practiceIdentity } from "@/lib/practice";
import { buildPracticeDigestSeries } from "@/lib/trends-series";
import { summarizeTrends } from "@/lib/trends-digest";
import { practiceDigestKey } from "@/lib/trends-practices";

// A Wednesday, so rolling mode's week window is simply the trailing seven days and
// every offset below reads as "N days ago".
const NOW = new Date("2026-06-17T12:00:00Z");

const PRACTICE = "Sauna";
const CEILING = 4;
const FLOOR = 2;

function makeProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // Rolling mode makes each completed week an exact 7-day block counted back from
  // today, so the fixture's offsets map to weeks without touching week_start.
  setWeekMode(pid, "rolling");
  return pid;
}

function dayBack(pid: number, back: number): string {
  return shiftDateStr(today(pid), -back);
}

// `created_at` is set explicitly: the column defaults to SQLite's own clock, which
// the fake JS clock does not move, so a defaulted row reads as younger than the
// window and would fail the existed-whole-window check.
function makeTarget(
  profileId: number,
  value: string,
  floor: number,
  ceiling: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO frequency_targets
           (profile_id, scope_kind, scope_value, scope_identity, per_week,
            per_week_max, created_at)
         VALUES (?, 'practice', ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        value,
        practiceIdentity(value),
        floor,
        ceiling,
        `${dayBack(profileId, 200)} 08:00:00`
      ).lastInsertRowid
  );
}

function logAt(
  profileId: number,
  spelling: string,
  back: number,
  durationMin?: number
): void {
  db.prepare(
    `INSERT INTO practice_logs (profile_id, practice, date, duration_min)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, spelling, dayBack(profileId, back), durationMin ?? null);
}

// The fixture ledger, four completed weeks deep (oldest first):
//   week 0 (28–34 days back): nothing            → under floor
//   week 1 (21–27):           three logged days  → floor met (spellings folded)
//   week 2 (14–20):           four logged days   → AT CEILING
//   week 3 (7–13):            three logged days  → floor met (one day logged twice)
// plus two sessions in the CURRENT week, which the ledger must not see.
function seedLedger(profileId: number): void {
  makeTarget(profileId, PRACTICE, FLOOR, CEILING);
  for (const back of [21, 23]) logAt(profileId, PRACTICE, back);
  // A different stored spelling of the same identity — it must count.
  logAt(profileId, " sauna ", 25);
  for (const back of [14, 16, 18, 20]) logAt(profileId, PRACTICE, back);
  logAt(profileId, PRACTICE, 7, 15);
  // One DAY logged twice: day-distinct counting means this is still one day, and
  // the duration for that day is the mean of the two sessions.
  logAt(profileId, PRACTICE, 9, 20);
  logAt(profileId, PRACTICE, 9, 30);
  logAt(profileId, PRACTICE, 11);
  // The in-progress week.
  logAt(profileId, PRACTICE, 2, 40);
  logAt(profileId, PRACTICE, 1);
}

describe("the Trends wellness lens read (#1632)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads completed weeks oldest-first with the range verdict for each", () => {
    const pid = makeProfile("lens-weeks");
    seedLedger(pid);

    const [practice] = getPracticeTrends(pid, 4);
    expect(practice.name).toBe(PRACTICE);
    expect(practice.perWeek).toBe(FLOOR);
    expect(practice.perWeekMax).toBe(CEILING);
    expect(practice.existedWholeWindow).toBe(true);

    expect(practice.weeks.map((w) => w.count)).toEqual([0, 3, 4, 3]);
    expect(practice.weeks.map((w) => w.verdict)).toEqual([
      "under",
      "met",
      "at-ceiling",
      "met",
    ]);
    // Oldest first: the strip renders left to right in this order.
    const starts = practice.weeks.map((w) => w.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it("never counts the in-progress week into the ledger", () => {
    const pid = makeProfile("lens-current");
    seedLedger(pid);

    const [practice] = getPracticeTrends(pid, 4);
    // The current week's two sessions are 1 and 2 days back; the newest LEDGER
    // week ends 7 days back, so neither day can be inside it.
    const newestWeekStart = practice.weeks[practice.weeks.length - 1].start;
    expect(newestWeekStart).toBe(dayBack(pid, 13));
    // They are still real sessions, and the window-wide tally says so — every
    // logged row in the window, including the two in the in-progress week.
    expect(practice.sessions).toBe(13);
  });

  it("rolls the ledger up into consistency and the current streak", () => {
    const pid = makeProfile("lens-consistency");
    seedLedger(pid);

    const [practice] = getPracticeTrends(pid, 4);
    expect(practice.consistency).toEqual({
      weeks: 4,
      met: 3,
      rate: 0.75,
      currentStreak: 3,
      bestStreak: 3,
    });
  });

  it("averages recorded minutes over the sessions that carried them", () => {
    const pid = makeProfile("lens-duration");
    seedLedger(pid);

    const [practice] = getPracticeTrends(pid, 4);
    // Only the days with minutes appear — an untimed day is not a zero — and the
    // twice-logged day is the mean of its two sessions, not of all three logs that
    // week. The in-progress week's timed session is on the series, because a
    // duration trend is per-session, not per completed week.
    expect(practice.duration).toEqual([
      { date: dayBack(pid, 9), value: 25 },
      { date: dayBack(pid, 7), value: 15 },
      { date: dayBack(pid, 2), value: 40 },
    ]);
  });

  it("leaves an UNTRACKED practice out — it has no range to be in", () => {
    const pid = makeProfile("lens-untracked");
    seedLedger(pid);
    logPracticeSession(pid, "Journaling", dayBack(pid, 10));
    logPracticeSession(pid, "Journaling", dayBack(pid, 17));

    const names = getPracticeTrends(pid, 4).map((p) => p.name);
    expect(names).toEqual([PRACTICE]);
  });

  it("anchors a window that ENDS IN THE PAST on that window's own end", () => {
    const pid = makeProfile("lens-anchor");
    seedLedger(pid);

    // Anchored two weeks ago, the newest completed week is the one before THAT —
    // the at-ceiling week, which is the newest week the ledger may now end on.
    const anchored = getPracticeTrends(pid, 2, dayBack(pid, 14))[0];
    expect(anchored.weeks.map((w) => w.verdict)).toEqual(["under", "met"]);
    expect(anchored.weeks[anchored.weeks.length - 1].start).toBe(
      dayBack(pid, 27)
    );
    // …and the trailing read from today still sees the whole thing.
    expect(getPracticeTrends(pid, 4)[0].weeks).toHaveLength(4);
  });

  it("offers a moved cadence to the digest as a NEUTRAL series", () => {
    const pid = makeProfile("lens-digest");
    seedLedger(pid);

    // Four weeks of window — the same four the ledger above walks.
    const range = { from: dayBack(pid, 27), to: today(pid) };
    const [series] = buildPracticeDigestSeries(pid, range, today(pid));
    expect(series.key).toBe(practiceDigestKey(practiceIdentity(PRACTICE)));
    expect(series.label).toBe(`${PRACTICE} cadence`);
    // No reference range: a coaching-tier chip must never take a crossing colour.
    expect(series.range).toBeUndefined();
    expect(series.points.map((p) => p.value)).toEqual([0, 3, 4, 3]);

    // The fixture's cadence really moved (0 → 3 days a week), so it surfaces.
    const [item] = summarizeTrends([series], { limit: 5 });
    expect(item.key).toBe(series.key);
    expect(item.direction).toBe("up");
    expect(item.rangeShift).toBeNull();
  });

  it("keeps an untracked practice out of the digest too", () => {
    const pid = makeProfile("lens-digest-untracked");
    for (const back of [8, 15, 22, 29]) {
      logPracticeSession(pid, "Breathwork", dayBack(pid, back));
    }
    expect(
      buildPracticeDigestSeries(
        pid,
        { from: dayBack(pid, 34), to: today(pid) },
        today(pid)
      )
    ).toEqual([]);
  });
});
