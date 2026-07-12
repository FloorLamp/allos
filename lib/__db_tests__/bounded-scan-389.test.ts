// DB INTEGRATION TIER — pins the equivalences the #389 bounded-scan fixes rely on:
//
//  • getExerciseE1rmSeries gained an optional `since` bound. Its only caller feeds
//    the result to detectPlateaus, which already windows each series to the trailing
//    PLATEAU_WINDOW_DAYS — so plateau findings over the BOUNDED series must equal
//    those over the FULL series. This proves the bound changes performance only.
//
//  • getActivitiesSince(profileId, since) returns exactly getActivities(profileId)
//    filtered to date >= since — the weekly-recap swap loads the recap's window
//    instead of all history, and getActivityDates still serves the streak over full
//    history (unchanged rows).
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import {
  getExerciseE1rmSeries,
  getActivities,
  getActivitiesSince,
  getActivityDates,
} from "@/lib/queries";
import {
  detectPlateaus,
  PLATEAU_WINDOW_DAYS,
} from "@/lib/training-observations";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addStrengthSession(
  profileId: number,
  date: string,
  exercise: string,
  weightKg: number,
  reps: number
): void {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', ?, 45)`
      )
      .run(profileId, date, `${exercise} day`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, ?, ?)`
  ).run(activityId, exercise, weightKg, reps);
}

const TODAY = "2024-06-01";

describe("getExerciseE1rmSeries bound → identical plateau findings (#389)", () => {
  it("detectPlateaus over the bounded series equals the full series", () => {
    const p = newProfile("e1rm plateau bound");
    // A recent FLAT stretch inside the window (a plateau) …
    for (const [i, d] of [40, 33, 26, 19, 12, 5].entries()) {
      addStrengthSession(p, shiftDateStr(TODAY, -d), "Bench Press", 100 + i, 5);
    }
    // … plus much OLDER, clearly-progressing sessions well before the window, which
    // the plateau window discards anyway. The bounded scan never loads these.
    for (const [i, d] of [400, 360, 320, 280].entries()) {
      addStrengthSession(
        p,
        shiftDateStr(TODAY, -d),
        "Bench Press",
        40 + i * 8,
        5
      );
    }

    const cutoff = shiftDateStr(TODAY, -PLATEAU_WINDOW_DAYS);
    const full = getExerciseE1rmSeries(p);
    const bounded = getExerciseE1rmSeries(p, cutoff);

    // The bounded series really did drop the pre-window points (fewer points).
    const fullBench = full.find((s) => s.exercise === "Bench Press")!;
    const boundedBench = bounded.find((s) => s.exercise === "Bench Press")!;
    expect(boundedBench.points.length).toBeLessThan(fullBench.points.length);

    // …yet the plateau findings are identical.
    expect(detectPlateaus(bounded, TODAY)).toEqual(detectPlateaus(full, TODAY));
  });

  it("full and bounded agree when there is no pre-window history", () => {
    const p = newProfile("e1rm no old history");
    for (const [i, d] of [30, 23, 16, 9, 2].entries()) {
      addStrengthSession(p, shiftDateStr(TODAY, -d), "Squat", 140 + i * 5, 5);
    }
    const cutoff = shiftDateStr(TODAY, -PLATEAU_WINDOW_DAYS);
    expect(detectPlateaus(getExerciseE1rmSeries(p, cutoff), TODAY)).toEqual(
      detectPlateaus(getExerciseE1rmSeries(p), TODAY)
    );
  });
});

describe("getActivitiesSince equals full-then-filter (#389)", () => {
  it("returns exactly the activities on or after `since`, and dates come from full history", () => {
    const p = newProfile("activities-since");
    const dates = [90, 60, 30, 14, 7, 3, 1, 0].map((d) =>
      shiftDateStr(TODAY, -d)
    );
    for (const d of dates) {
      addStrengthSession(p, d, "Deadlift", 180, 3);
    }

    const since = shiftDateStr(TODAY, -14);
    const bounded = getActivitiesSince(p, since);
    const fullFiltered = getActivities(p).filter((a) => a.date >= since);
    expect(bounded).toEqual(fullFiltered);

    // getActivityDates still reflects the FULL history (streak input), not the window.
    expect(new Set(getActivityDates(p))).toEqual(new Set(dates));
    expect(getActivityDates(p).length).toBeGreaterThan(bounded.length);
  });

  it("returns [] when nothing falls in the window", () => {
    const p = newProfile("activities-since-empty");
    addStrengthSession(p, shiftDateStr(TODAY, -400), "Row", 60, 8);
    expect(getActivitiesSince(p, shiftDateStr(TODAY, -14))).toEqual([]);
  });
});
