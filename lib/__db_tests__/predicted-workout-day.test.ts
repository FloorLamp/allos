// DB INTEGRATION TIER (issue #558).
//
// Pre-workout supplement dueness must key on the PREDICTED training day (from the
// inferred cadence), not on "a workout was already logged today". This exercises
// the DB-touching predictor against a seeded training pattern:
//   • a habitual Mon/Wed/Fri trainer → isPredictedWorkoutDay true on those
//     weekdays, false on the others, with NO activity logged for the queried day;
//   • a pre_workout supplement is due on a predicted workout day with nothing
//     logged yet, and hidden on a predicted rest day;
//   • no discernible cadence → the predictor returns null (caller falls back to
//     the logged signal).
//
// Deterministic: :memory:-backed temp DB via setup.ts; no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { inferWorkoutSchedule, isPredictedWorkoutDay } from "@/lib/queries";
import { isDueOn } from "@/lib/supplement-schedule";
import { shiftDateStr, weekdayOfDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Log a strength session on `date` at 07:00.
function logWorkout(profileId: number, date: string): void {
  db.prepare(
    `INSERT INTO activities (profile_id, date, type, title, duration_min, start_time, end_time)
     VALUES (?, ?, 'strength', 'Session', 45, '07:00', '07:45')`
  ).run(profileId, date);
}

// The next date on-or-after `from` whose weekday is `wd` (0=Sun … 6=Sat).
function nextWeekday(from: string, wd: number): string {
  let d = from;
  for (let i = 0; i < 7; i++) {
    if (weekdayOfDateStr(d) === wd) return d;
    d = shiftDateStr(d, 1);
  }
  return from;
}

describe("predicted workout day (#558)", () => {
  it("predicts habitual training weekdays without a logged session that day", () => {
    const p = newProfile("Mon/Wed/Fri trainer");
    const td = today(p);
    // Seed 8 weeks of Mon/Wed/Fri sessions ending well before today's query.
    for (let w = 1; w <= 8; w++) {
      const weekStart = shiftDateStr(td, -w * 7);
      for (const wd of [1, 3, 5]) {
        logWorkout(p, nextWeekday(weekStart, wd));
      }
    }

    const inf = inferWorkoutSchedule(p);
    expect(inf.hasPattern).toBe(true);
    expect(inf.weekdays).toEqual([1, 3, 5]);

    // A future Monday with NOTHING logged is still a predicted workout day.
    const nextMon = nextWeekday(shiftDateStr(td, 1), 1);
    const nextTue = nextWeekday(shiftDateStr(td, 1), 2);
    expect(getLogged(p, nextMon)).toBe(0);
    expect(isPredictedWorkoutDay(p, nextMon)).toBe(true);
    expect(isPredictedWorkoutDay(p, nextTue)).toBe(false);

    const pre = { condition: "pre_workout" as const, situation: null };
    // Due on a predicted workout day with no logged activity; hidden on rest day.
    expect(
      isDueOn(pre, {
        isWorkoutDay: false,
        activeSituations: new Set<string>(),
        predictedWorkoutDay: isPredictedWorkoutDay(p, nextMon),
      })
    ).toBe(true);
    expect(
      isDueOn(pre, {
        isWorkoutDay: false,
        activeSituations: new Set<string>(),
        predictedWorkoutDay: isPredictedWorkoutDay(p, nextTue),
      })
    ).toBe(false);
  });

  it("returns null when no cadence can be inferred", () => {
    const p = newProfile("no pattern");
    // A single session isn't a habit → no weekday clears the min-dates gate.
    logWorkout(p, shiftDateStr(today(p), -3));
    const inf = inferWorkoutSchedule(p);
    expect(inf.hasPattern).toBe(false);
    expect(isPredictedWorkoutDay(p, today(p))).toBeNull();
  });
});

function getLogged(profileId: number, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM activities WHERE profile_id = ? AND date = ?"
      )
      .get(profileId, date) as { n: number }
  ).n;
}
