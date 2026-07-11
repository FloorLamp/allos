// DB INTEGRATION TIER — bodyweight-KIND parity across the two strength builders.
//
// getStrengthByExercise (detail panel / coaching / Telegram) and
// getRecentExerciseHistory (the activity editor's next-set chip) once classified
// an exercise's bodyweight KIND over DIFFERENT windows — all-history vs a 365-day
// slice — so an exercise last loaded with external weight >12 months ago and done
// bodyweight-only since produced "add weight" on one surface and "BW × N+1" on the
// other (#331). This seeds exactly that scenario in a real DB and proves the two
// builders now agree, and separately that the classification is the all-history
// one.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { getRecentExerciseHistory, getStrengthByExercise } from "@/lib/queries";

// A non-catalog lift (so its KIND turns purely on whether external weight was ever
// seen, not on a catalog bodyweight flag).
const EXERCISE = "Sled Drag";
const KEY = EXERCISE.toLowerCase();

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('BW Parity')").run()
      .lastInsertRowid
  );
  const t = today(profileId);
  // Stale externally-loaded session, >12 months ago (outside the editor's
  // 365-day window).
  const staleDate = shiftDateStr(t, -420);
  // Two recent bodyweight-only sessions (inside the window).
  const recentA = shiftDateStr(t, -40);
  const recentB = shiftDateStr(t, -12);

  const addSession = (date: string, weightKg: number | null, reps: number) => {
    const activityId = Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, duration_min)
           VALUES (?, ?, 'strength', 'Session', 30)`
        )
        .run(profileId, date).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
       VALUES (?, ?, 1, ?, ?)`
    ).run(activityId, EXERCISE, weightKg, reps);
  };

  addSession(staleDate, 20, 8); // loaded 20 kg, >1yr ago
  addSession(recentA, null, 12); // bodyweight only
  addSession(recentB, null, 15); // bodyweight only
});

describe("bodyweight KIND agrees across both builders (#331)", () => {
  it("both classify the stale-loaded lift as weighted (all-history)", () => {
    const stat = getStrengthByExercise(profileId).find(
      (s) => s.exercise.toLowerCase() === KEY
    );
    const hist = getRecentExerciseHistory(profileId, 4)[KEY];

    expect(stat).toBeTruthy();
    expect(hist).toBeTruthy();
    // The old load lives outside the editor's 365-day window; before the fix the
    // editor saw only bodyweight sets and would have said `true`.
    expect(hist.bodyweight).toBe(false);
    // One question, one computation: the two surfaces cannot disagree.
    expect(hist.bodyweight).toBe(stat!.bodyweight);
  });
});
