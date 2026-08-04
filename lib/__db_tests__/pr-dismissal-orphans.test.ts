// DB INTEGRATION TIER — #1931: a re-earned personal record must never inherit the
// silence of a dismissal minted for data that no longer exists.
//
// `pr:strength:<movementLoadKey>:<kind>` and `pr:cardio:<activityHistoryKey>:<kind>`
// embed a user-recyclable string. Nothing swept them, so the sequence
//
//     celebrate → dismiss → the backing sets/sessions are edited away or deleted
//                        → months later the same lift/activity is trained again
//
// ended with a genuine new record arriving PRE-SILENCED. This proves the sweep runs at
// the seams that can un-back a key, that it leaves a LIVE dismissal alone, and that the
// end-to-end effect is the celebration coming back.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { deleteEquipment } from "@/lib/equipment";
import { recentPRs, recentCardioPRs } from "@/lib/coaching";
import {
  cardioPrToFinding,
  isFindingSuppressed,
  prToFinding,
} from "@/lib/findings";
import {
  prCardioDismissalKey,
  prStrengthDismissalKey,
} from "@/lib/dismissal-keys";
import {
  cleanupOrphanPrDismissals,
  dismissFinding,
  getCardioByActivity,
  getFindingSuppressions,
  getStrengthByExercise,
} from "@/lib/queries";

let profileId: number;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addStrengthSession(
  profile: number,
  date: string,
  exercise: string,
  weightKg: number,
  reps: number,
  equipmentId: number | null = null
): number {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profile, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets
       (activity_id, exercise, set_number, weight_kg, reps, equipment_id, warmup)
     VALUES (?, ?, 1, ?, ?, ?, 0)`
  ).run(activityId, exercise, weightKg, reps, equipmentId);
  return activityId;
}

function addCardioSession(
  profile: number,
  date: string,
  activity: string,
  distanceKm: number,
  durationMin: number
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, distance_km, duration_min)
         VALUES (?, ?, 'cardio', ?, ?, ?)`
      )
      .run(profile, date, activity, distanceKm, durationMin).lastInsertRowid
  );
}

function storedPrKeys(profile: number): string[] {
  return (
    db
      .prepare(
        `SELECT signal_key FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key LIKE 'pr:%'
          ORDER BY signal_key`
      )
      .all(profile) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

beforeAll(() => {
  profileId = newProfile("PR Orphans");
});

describe("cleanupOrphanPrDismissals (#1931)", () => {
  it("drops a dismissal whose movement has no sets left, and keeps the live one", () => {
    const p = newProfile("PR Sweep");
    const t = today(p);
    addStrengthSession(p, shiftDateStr(t, -30), "Bench Press", 80, 5);
    addStrengthSession(p, shiftDateStr(t, -3), "Bench Press", 90, 5);
    const deadActivity = addStrengthSession(
      p,
      shiftDateStr(t, -20),
      "Barbell Curl",
      35,
      8
    );
    addStrengthSession(p, shiftDateStr(t, -10), "Barbell Curl", 40, 8);

    const live = prStrengthDismissalKey("Bench Press", null, "1rm");
    const doomed = prStrengthDismissalKey("Barbell Curl", null, "1rm");
    dismissFinding(p, live);
    dismissFinding(p, doomed);
    // Nothing has lost its backing yet — a sweep now must be a no-op.
    cleanupOrphanPrDismissals(p);
    expect(storedPrKeys(p)).toEqual([doomed, live].sort());

    // Remove every set of the curl (the second one via a raw delete of its parent).
    db.prepare("DELETE FROM activities WHERE profile_id = ? AND id = ?").run(
      p,
      deadActivity
    );
    db.prepare(
      `DELETE FROM activities
        WHERE profile_id = ? AND id IN (
          SELECT a.id FROM activities a JOIN exercise_sets s ON s.activity_id = a.id
           WHERE a.profile_id = ? AND s.exercise = 'Barbell Curl')`
    ).run(p, p);

    cleanupOrphanPrDismissals(p);
    expect(storedPrKeys(p)).toEqual([live]);
  });

  it("sweeps a cardio dismissal only once every session of that activity is gone", () => {
    const p = newProfile("PR Cardio Sweep");
    const t = today(p);
    addCardioSession(p, shiftDateStr(t, -20), "Cycling", 20, 40);
    const lastRow = addCardioSession(p, shiftDateStr(t, -4), "Rowing", 8, 45);
    addCardioSession(p, shiftDateStr(t, -12), "Rowing", 6, 30);

    const live = prCardioDismissalKey("Cycling", "speed");
    const doomed = prCardioDismissalKey("Rowing", "distance");
    dismissFinding(p, live);
    dismissFinding(p, doomed);

    // One of two Rowing sessions removed: the activity is still logged, so nothing
    // has lost its backing.
    db.prepare("DELETE FROM activities WHERE profile_id = ? AND id = ?").run(
      p,
      lastRow
    );
    cleanupOrphanPrDismissals(p);
    expect(storedPrKeys(p)).toEqual([doomed, live].sort());

    db.prepare(
      "DELETE FROM activities WHERE profile_id = ? AND title = 'Rowing'"
    ).run(p);
    cleanupOrphanPrDismissals(p);
    expect(storedPrKeys(p)).toEqual([live]);
  });

  it("leaves other namespaces' suppressions untouched", () => {
    const p = newProfile("PR Sweep Neighbours");
    dismissFinding(p, "biomarker:ldl cholesterol");
    dismissFinding(p, "training-obs:stale:curl:2026-01");
    dismissFinding(p, prStrengthDismissalKey("Deadlift", null, "1rm"));
    cleanupOrphanPrDismissals(p);
    const all = (
      db
        .prepare(
          "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
        )
        .all(p) as { signal_key: string }[]
    ).map((r) => r.signal_key);
    // The PR key had no backing at all and goes; the two neighbours stay.
    expect(all).toEqual([
      "biomarker:ldl cholesterol",
      "training-obs:stale:curl:2026-01",
    ]);
  });

  it("is a no-op — and reads no history — for a profile with no PR dismissals", () => {
    const p = newProfile("PR Sweep Empty");
    dismissFinding(p, "dose:1");
    cleanupOrphanPrDismissals(p);
    expect(storedPrKeys(p)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ?"
        )
        .get(p)
    ).toEqual({ n: 1 });
  });
});

describe("the regression this issue exists for (#1931)", () => {
  it("a genuinely re-earned strength PR is NOT silenced by the old dismissal", () => {
    const t = today(profileId);
    // Two barbell sessions build a real record on the unassigned lane.
    addStrengthSession(profileId, shiftDateStr(t, -400), "Bench Press", 80, 5);
    addStrengthSession(profileId, shiftDateStr(t, -395), "Bench Press", 95, 5);

    const record = recentPRs(
      getStrengthByExercise(profileId, true),
      shiftDateStr(t, -395),
      0
    ).find((r) => r.kind === "1rm");
    expect(record).toBeDefined();
    const finding = prToFinding(record!, "kg");

    // The user celebrates and dismisses it.
    dismissFinding(profileId, finding.dedupeKey);
    expect(
      isFindingSuppressed(
        finding,
        getFindingSuppressions(profileId),
        shiftDateStr(t, -395)
      )
    ).toBe(true);

    // Those sets are then edited away entirely (the barbell history is deleted).
    db.prepare(
      `DELETE FROM activities
        WHERE profile_id = ? AND id IN (
          SELECT a.id FROM activities a JOIN exercise_sets s ON s.activity_id = a.id
           WHERE a.profile_id = ? AND s.exercise = 'Bench Press')`
    ).run(profileId, profileId);
    cleanupOrphanPrDismissals(profileId);

    // Much later the SAME lift is trained again and a new record is genuinely earned.
    addStrengthSession(profileId, shiftDateStr(t, -20), "Bench Press", 100, 5);
    addStrengthSession(profileId, shiftDateStr(t, -2), "Bench Press", 110, 5);
    const reEarned = recentPRs(getStrengthByExercise(profileId, true), t, 30)
      .filter((r) => r.kind === "1rm")
      .find((r) => r.exercise.toLowerCase() === "bench press");
    expect(reEarned).toBeDefined();
    const reFinding = prToFinding(reEarned!, "kg");
    // Same key — this is the same lift — but the dead dismissal is gone, so the
    // celebration surfaces instead of being suppressed by a row minted for data that
    // no longer exists.
    expect(reFinding.dedupeKey).toBe(finding.dedupeKey);
    expect(
      isFindingSuppressed(reFinding, getFindingSuppressions(profileId), t)
    ).toBe(false);
  });

  it("a genuinely re-logged cardio PR is NOT silenced by the old dismissal", () => {
    const p = newProfile("PR Cardio Regression");
    const t = today(p);
    addCardioSession(p, shiftDateStr(t, -300), "Rowing", 5, 30);
    addCardioSession(p, shiftDateStr(t, -295), "Rowing", 9, 50);
    const first = recentCardioPRs(
      getCardioByActivity(p, "km"),
      shiftDateStr(t, -295),
      0
    ).find((r) => r.kind === "distance");
    expect(first).toBeDefined();
    const finding = cardioPrToFinding(first!, "km");
    dismissFinding(p, finding.dedupeKey);

    db.prepare(
      "DELETE FROM activities WHERE profile_id = ? AND title = 'Rowing'"
    ).run(p);
    cleanupOrphanPrDismissals(p);

    // Re-logged later — deliberately with a DIFFERENT casing, which is the same
    // activity and must therefore be the same key (#1931's identity half).
    addCardioSession(p, shiftDateStr(t, -15), "rowing", 6, 35);
    addCardioSession(p, shiftDateStr(t, -1), "rowing", 12, 65);
    const reEarned = recentCardioPRs(getCardioByActivity(p, "km"), t, 30).find(
      (r) => r.kind === "distance"
    );
    expect(reEarned).toBeDefined();
    const reFinding = cardioPrToFinding(reEarned!, "km");
    expect(reFinding.dedupeKey).toBe(finding.dedupeKey);
    expect(isFindingSuppressed(reFinding, getFindingSuppressions(p), t)).toBe(
      false
    );
  });

  it("deleting an implement retires its lane's dismissals (deleteEquipment seam)", () => {
    const p = newProfile("PR Equipment Seam");
    const t = today(p);
    const machineId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Hotel chest press', 'Machine')`
        )
        .run(p).lastInsertRowid
    );
    const homeId = Number(
      db
        .prepare(
          `INSERT INTO equipment (profile_id, name, category) VALUES (?, 'Home chest press', 'Machine')`
        )
        .run(p).lastInsertRowid
    );
    addStrengthSession(
      p,
      shiftDateStr(t, -20),
      "Machine Chest Press",
      50,
      5,
      machineId
    );
    addStrengthSession(
      p,
      shiftDateStr(t, -10),
      "Machine Chest Press",
      80,
      5,
      homeId
    );
    const hotelKey = prStrengthDismissalKey(
      "Machine Chest Press",
      machineId,
      "1rm"
    );
    const homeKey = prStrengthDismissalKey(
      "Machine Chest Press",
      homeId,
      "1rm"
    );
    dismissFinding(p, hotelKey);
    dismissFinding(p, homeKey);

    // Deleting the hotel machine moves its sets to the unassigned lane, so the hotel
    // LANE no longer exists — its dismissal must not outlive it and wait for the id
    // to be reissued.
    deleteEquipment(p, machineId);
    expect(storedPrKeys(p)).toEqual([homeKey]);
  });
});
