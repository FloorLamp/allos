// SERVER-ACTION TIER — saveActivity persists the per-set warmup flag (#338).
//
// A warmup-flagged set must round-trip to exercise_sets.warmup = 1, and a set
// with no flag (or an older client that omits it) stays a working set (0). The
// column is NOT NULL DEFAULT 0, so an omitted flag is a working set.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { getStrengthByExercise } from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function warmupFlags(activityId: number): number[] {
  return (
    db
      .prepare(
        "SELECT warmup FROM exercise_sets WHERE activity_id = ? ORDER BY set_number"
      )
      .all(activityId) as { warmup: number }[]
  ).map((r) => r.warmup);
}

describe("saveActivity warmup flag (issue #338)", () => {
  it("persists warmup=1 for a flagged set and 0 otherwise", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("warmup-lifter", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "strength",
        title: "Bench",
        date: "2026-07-05",
        components: JSON.stringify([
          {
            name: "Bench Press",
            type: "strength",
            distance: null,
            duration_min: null,
          },
        ]),
        sets: JSON.stringify([
          {
            exercise: "Bench Press",
            weight: 60,
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
            warmup: true,
          },
          {
            exercise: "Bench Press",
            weight: 100,
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
            warmup: false,
          },
          {
            exercise: "Bench Press",
            weight: 100,
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
            // warmup omitted entirely → a working set (DEFAULT 0)
          },
        ]),
      })
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(warmupFlags(res.id!)).toEqual([1, 0, 0]);
  });

  it("excludes the warmup set from the exercise's derived stats", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("warmup-stats", login.id);
    actAs(login, profile);

    await saveActivity(
      fd({
        type: "strength",
        title: "Bench",
        date: "2026-07-05",
        components: JSON.stringify([
          {
            name: "Bench Press",
            type: "strength",
            distance: null,
            duration_min: null,
          },
        ]),
        sets: JSON.stringify([
          {
            // A heavy warmup single that would otherwise win the e1RM ranking.
            exercise: "Bench Press",
            weight: 120,
            reps: 1,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
            warmup: true,
          },
          {
            exercise: "Bench Press",
            weight: 100,
            reps: 5,
            weightRight: null,
            repsRight: null,
            durationSec: null,
            durationSecRight: null,
            equipmentId: null,
          },
        ]),
      })
    );

    const stat = getStrengthByExercise(profile.id).find(
      (s) => s.exercise === "Bench Press"
    );
    // The 120×1 warmup is inert: best/top weight comes from the 100×5 working set.
    expect(stat?.topWeightKg).toBe(100);
    expect(stat?.bestWeightKg).toBe(100);
    expect(stat?.totalSets).toBe(1); // only the working set counts
  });
});
