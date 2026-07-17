// DB INTEGRATION TIER — the server-side session-recap gather (issue #924).
// getSessionRecap maps a stored activity + its recent per-exercise history onto the
// pure sessionRecap, feeding both the finished-window dashboard card and the
// recap-led finish nudge. Pins the end-to-end recap over a seeded fixture: working
// sets/volume, PR + vs-last delta against a real prior session, target rollup, and
// that an imported activity with no target data recaps honestly.
//
// Every value is synthetic. Runs against a throwaway DB (lib/__db_tests__/setup.ts).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getSessionRecap } from "@/lib/queries";

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
  sets: {
    weightKg: number;
    reps: number;
    targetReps?: number | null;
    warmup?: number;
  }[],
  opts: { source?: string | null; durationMin?: number } = {}
): number {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min, source, external_id)
           VALUES (?, ?, 'strength', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        date,
        `${exercise} day`,
        opts.durationMin ?? 45,
        opts.source ?? null,
        opts.source ? `${opts.source}:${date}` : null
      ).lastInsertRowid
  );
  sets.forEach((s, i) => {
    db.prepare(
      `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, target_reps, warmup)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      activityId,
      exercise,
      i + 1,
      s.weightKg,
      s.reps,
      s.targetReps ?? null,
      s.warmup ?? 0
    );
  });
  return activityId;
}

describe("getSessionRecap gather (#924)", () => {
  it("recaps a session with PR, vs-last delta, working sets, and target rollup", () => {
    const p = newProfile("RecapGather");
    // Prior session: Bench 60kg × 5 (the beaten baseline).
    addStrengthSession(p, "2026-07-10", "Bench Press", [
      { weightKg: 60, reps: 5 },
    ]);
    // Today: a warmup + two working sets at 65kg × 5, target 5 (met).
    const todayId = addStrengthSession(p, "2026-07-17", "Bench Press", [
      { weightKg: 40, reps: 8, warmup: 1 },
      { weightKg: 65, reps: 5, targetReps: 5 },
      { weightKg: 65, reps: 5, targetReps: 5 },
    ]);

    const recap = getSessionRecap(p, todayId);
    expect(recap).not.toBeNull();
    expect(recap!.totalWorkingSets).toBe(2);
    expect(recap!.totalVolumeKg).toBe(650); // 65*5 + 65*5, warmup excluded
    expect(recap!.targetRollup).toBe("all-hit");

    const ex = recap!.exercises[0];
    expect(ex.exercise).toBe("Bench Press");
    expect(ex.e1rmPR).toBe(true);
    expect(ex.weightPR).toBe(true);
    expect(ex.verdict).toBe("met");
    // 65 vs 60 at 5 reps: 5*(1+5/30) = 5.833… → 5.8
    expect(ex.deltaE1rmKg).toBeCloseTo(5.8, 1);
    expect(recap!.prExercises).toEqual(["Bench Press"]);
  });

  it("recaps an imported activity honestly — no target data, no PR without history", () => {
    const p = newProfile("RecapImport");
    // A single imported strength session (first-ever, no targets, no prior history).
    const id = addStrengthSession(
      p,
      "2026-07-17",
      "Bench Press",
      [{ weightKg: 50, reps: 8 }],
      { source: "strava" }
    );

    const recap = getSessionRecap(p, id);
    expect(recap).not.toBeNull();
    expect(recap!.totalWorkingSets).toBe(1);
    expect(recap!.exercises[0].verdict).toBeNull(); // no declared targets
    expect(recap!.exercises[0].e1rmPR).toBe(false); // not established (first session)
    expect(recap!.exercises[0].deltaE1rmKg).toBeNull();
    expect(recap!.targetRollup).toBe("none-targeted");
    expect(recap!.prExercises).toEqual([]);
  });

  it("returns null for a missing activity", () => {
    const p = newProfile("RecapMissing");
    expect(getSessionRecap(p, 999999)).toBeNull();
  });
});
