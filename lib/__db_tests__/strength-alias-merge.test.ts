// DB INTEGRATION TIER — #331 defect 2 (renames split progression history) and the
// >1yr-old-seed decision, exercised against the real schema + query layer.
//
// Defect 2: getStrengthByExercise (and the editor's getRecentExerciseHistory)
// keyed history by the exact logged name, so a variant and its base — e.g. after
// renaming "Barbell Curl" → "Curl" — became two independent histories with their
// own PRs, session counts, and progression seed. The fix keys every builder
// through the canonical exerciseHistoryKey so they merge. This seeds both spellings
// in a real DB and proves one merged history on both surfaces.
//
// Seed decision: a session older than the recent window seeds a next-set
// suggestion on NEITHER surface — the editor's scan is windowed (no chip) and
// getStrengthByExercise withholds lastSessionBest/lastSessionSets on the same
// boundary.

import { beforeAll, describe, expect, it } from "vitest";

import { shiftDateStr } from "@/lib/date";
import { db, today } from "@/lib/db";
import { exerciseHistoryKey } from "@/lib/lifts";
import { getRecentExerciseHistory, getStrengthByExercise } from "@/lib/queries";

let profileId: number;
let staleProfileId: number;

function addSession(
  profile: number,
  date: string,
  exercise: string,
  weightKg: number | null,
  reps: number
) {
  const activityId = Number(
    db
      .prepare(
        `INSERT INTO activities (profile_id, date, type, title, duration_min)
         VALUES (?, ?, 'strength', 'Session', 30)`
      )
      .run(profile, date).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps)
     VALUES (?, ?, 1, ?, ?)`
  ).run(activityId, exercise, weightKg, reps);
}

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Alias Merge')").run()
      .lastInsertRowid
  );
  const t = today(profileId);
  // Same lift logged under a composed variant AND its bare base (the rename case),
  // both inside the recent window. The base session is heavier and newer.
  addSession(profileId, shiftDateStr(t, -20), "Barbell Curl", 40, 8);
  addSession(profileId, shiftDateStr(t, -5), "Curl", 50, 6);

  staleProfileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('Stale Seed')").run()
      .lastInsertRowid
  );
  // A lift trained only >12 months ago — outside the recent window.
  addSession(
    staleProfileId,
    shiftDateStr(today(staleProfileId), -400),
    "Deadlift",
    100,
    5
  );
});

describe("alias-merged history aggregation (#331 defect 2)", () => {
  it("aggregates a variant and its base into ONE strength stat", () => {
    const stats = getStrengthByExercise(profileId);
    const curl = stats.filter((s) => exerciseHistoryKey(s.exercise) === "curl");
    expect(curl).toHaveLength(1); // not two split histories
    // Both sessions counted, and the PR reflects the heavier base session.
    expect(curl[0].sessions).toBe(2);
    expect(curl[0].totalSets).toBe(2);
    expect(curl[0].topWeightKg).toBe(50);
  });

  it("merges the editor's per-exercise history under the canonical key", () => {
    const hist = getRecentExerciseHistory(profileId, 4);
    expect(hist["curl"]).toBeTruthy();
    expect(hist["curl"].sessions).toHaveLength(2);
    // No split entry survives under the raw variant spelling.
    expect(hist["barbell curl"]).toBeUndefined();
    // The newest session keeps its own logged name so the editor can still
    // recover the last-used variant after the merge.
    expect(hist["curl"].sessions[0].exercise).toBe("Curl");
  });
});

describe(">1yr-old seed suggests on neither surface (#331)", () => {
  it("getStrengthByExercise keeps the stat but withholds the stale seed", () => {
    const stat = getStrengthByExercise(staleProfileId).find(
      (s) => s.exercise.toLowerCase() === "deadlift"
    );
    expect(stat).toBeTruthy();
    expect(stat!.sessions).toBe(1); // historical stats survive
    expect(stat!.lastSessionBest).toBeNull(); // …but the forward seed is dropped
    expect(stat!.lastSessionSets).toEqual([]);
  });

  it("the editor shows no chip for a lift last trained >12 months ago", () => {
    const hist = getRecentExerciseHistory(staleProfileId, 4);
    expect(hist["deadlift"]).toBeUndefined();
  });
});
