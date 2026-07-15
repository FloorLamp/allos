// SERVER-ACTION TIER — saveActivity persists the per-set RPE (#743).
//
// RPE is OPTIONAL: a set with a rating round-trips to exercise_sets.rpe, a set
// without one stores NULL, and the write boundary canonicalizes off-step / out-of-
// scale values (lib/rpe.ts canonicalRpe) BEFORE they reach the DB — the CHECK
// (5–10) never has to reject a raw write. RPE composes with the declared intent
// (target_reps / to_failure) on the same row rather than replacing it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function rpes(activityId: number): (number | null)[] {
  return (
    db
      .prepare(
        "SELECT rpe FROM exercise_sets WHERE activity_id = ? ORDER BY set_number"
      )
      .all(activityId) as { rpe: number | null }[]
  ).map((r) => r.rpe);
}

// One strength set with sensible defaults; override only what a case cares about.
const setPayload = (o: Record<string, unknown>) => ({
  exercise: "Bench Press",
  weight: 100,
  reps: 5,
  weightRight: null,
  repsRight: null,
  durationSec: null,
  durationSecRight: null,
  equipmentId: null,
  ...o,
});

async function logBench(sets: Record<string, unknown>[]) {
  return saveActivity(
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
      sets: JSON.stringify(sets.map(setPayload)),
    })
  );
}

describe("saveActivity RPE (issue #743)", () => {
  it("persists a logged RPE and stores NULL when omitted", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("rpe-lifter", login.id);
    actAs(login, profile);

    const res = await logBench([
      { rpe: 8 },
      { rpe: 9.5 },
      {}, // no rpe → NULL
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(rpes(res.id!)).toEqual([8, 9.5, null]);
  });

  it("composes RPE with the declared rep target on the same set", async () => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile("rpe-target", login.id);
    actAs(login, profile);

    const res = await logBench([{ reps: 5, rpe: 8, targetReps: 5 }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = db
      .prepare(
        "SELECT rpe, target_reps FROM exercise_sets WHERE activity_id = ?"
      )
      .get(res.id!) as { rpe: number; target_reps: number };
    expect(row).toEqual({ rpe: 8, target_reps: 5 });
  });

  describe("half-point / range validation at the boundary", () => {
    it("snaps an off-step in-range value to the nearest half point", async () => {
      const login = createLogin({ weightUnit: "kg" });
      const profile = createProfile("rpe-snap", login.id);
      actAs(login, profile);

      // 8.2 → 8.0, 8.3 → 8.5 (canonicalRpe rounds to the 0.5 grid).
      const res = await logBench([{ rpe: 8.2 }, { rpe: 8.3 }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(rpes(res.id!)).toEqual([8, 8.5]);
    });

    it("rejects an out-of-scale value to NULL rather than throwing the CHECK", async () => {
      const login = createLogin({ weightUnit: "kg" });
      const profile = createProfile("rpe-range", login.id);
      actAs(login, profile);

      // 4 is below the 5 floor, 11 above the 10 ceiling — both dropped to NULL,
      // and the set itself still saves.
      const res = await logBench([{ rpe: 4 }, { rpe: 11 }, { rpe: 10 }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(rpes(res.id!)).toEqual([null, null, 10]);
    });
  });
});
