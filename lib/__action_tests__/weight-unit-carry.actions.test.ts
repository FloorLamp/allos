// SERVER-ACTION TIER — the captured-unit carry (issue #630).
//
// Weight/distance forms post the unit the value was CAPTURED in and the action
// honors it, rather than re-reading the login's stored pref at write time. This
// is the #467 compare-and-set principle generalized: a debounced auto-save (or a
// slow manual submit) can land after the login flipped its unit in another tab —
// re-reading the pref would then mis-convert a correctly-entered number. Here the
// login's STORED pref is deliberately the OPPOSITE of the submitted unit, so a
// pref-reading write would corrupt the value; the submitted unit must win.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity, logBodyweight } from "@/app/(app)/journal/actions";
import { createGoal } from "@/app/(app)/goals/actions";
import { LB_PER_KG } from "@/lib/units";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

function firstSetWeight(activityId: number): number {
  return (
    db
      .prepare(
        "SELECT weight_kg FROM exercise_sets WHERE activity_id = ? AND set_number = 1"
      )
      .get(activityId) as { weight_kg: number }
  ).weight_kg;
}

describe("saveActivity honors the submitted weight/distance unit (issue #630)", () => {
  it("stores a set entered in kg as kg even when the login pref is now lb", async () => {
    // Login pref flipped to lb after the form (rendered in kg) was opened.
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("carry-kg", login.id);
    actAs(login, profile);

    await saveActivity(
      fd({
        type: "strength",
        title: "Lift",
        date: "2026-07-01",
        weight_unit: "kg", // captured in kg
        distance_unit: "km",
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
            weight: 100, // 100 kg, NOT 100 lb (would be ~45.4 kg)
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

    const id = Number(
      (
        db
          .prepare(
            "SELECT id FROM activities WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
          )
          .get(profile.id) as { id: number }
      ).id
    );
    expect(firstSetWeight(id)).toBe(100);
  });

  it("stores a cardio distance entered in km even when the login pref is now mi", async () => {
    const login = createLogin({ distanceUnit: "mi" });
    const profile = createProfile("carry-km", login.id);
    actAs(login, profile);

    await saveActivity(
      fd({
        type: "cardio",
        title: "Run",
        date: "2026-07-01",
        weight_unit: "kg",
        distance_unit: "km", // captured in km
        components: JSON.stringify([
          { name: "Running", type: "cardio", distance: 10, duration_min: 50 },
        ]),
        sets: JSON.stringify([]),
      })
    );

    const row = db
      .prepare(
        "SELECT distance_km FROM activities WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { distance_km: number };
    // 10 km stored as 10 km, not 10 mi (≈16.1 km).
    expect(row.distance_km).toBeCloseTo(10, 6);
  });

  it("falls back to the stored pref when no weight_unit is submitted (older client)", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("carry-fallback", login.id);
    actAs(login, profile);

    await saveActivity(
      fd({
        type: "strength",
        title: "Lift",
        date: "2026-07-01",
        // no weight_unit / distance_unit fields
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
            weight: 100, // interpreted as lb per stored pref
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

    const id = Number(
      (
        db
          .prepare(
            "SELECT id FROM activities WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
          )
          .get(profile.id) as { id: number }
      ).id
    );
    expect(firstSetWeight(id)).toBeCloseTo(100 / LB_PER_KG, 6);
  });
});

describe("logBodyweight honors the passed weight unit (issue #630)", () => {
  it("stores a kg-captured bodyweight as kg even when the login pref is now lb", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("bw-kg", login.id);
    actAs(login, profile);

    await logBodyweight(80, "2026-07-01", "kg");

    const row = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { weight_kg: number };
    expect(row.weight_kg).toBe(80);
  });

  it("falls back to the stored pref when no unit is passed", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("bw-fallback", login.id);
    actAs(login, profile);

    await logBodyweight(150, "2026-07-01");

    const row = db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { weight_kg: number };
    expect(row.weight_kg).toBeCloseTo(150 / LB_PER_KG, 6);
  });
});

describe("createGoal honors the submitted weight unit (issue #630)", () => {
  it("stores a kg-captured body-weight goal as kg even when the login pref is now lb", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("goal-kg", login.id);
    actAs(login, profile);

    const res = await createGoal(
      fd({
        kind: "body",
        body_metric: "weight",
        body_target: 75, // 75 kg
        weight_unit: "kg",
        title: "Target bodyweight",
      })
    );
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        "SELECT target_value FROM goals WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { target_value: number };
    expect(row.target_value).toBe(75);
  });

  it("stores an exercise weight goal captured in kg even when the login pref is now lb", async () => {
    const login = createLogin({ weightUnit: "lb" });
    const profile = createProfile("goal-ex-kg", login.id);
    actAs(login, profile);

    const res = await createGoal(
      fd({
        kind: "exercise",
        exercise: "Bench Press",
        metric: "weight",
        target_weight: 100, // 100 kg
        weight_unit: "kg",
      })
    );
    expect(res.ok).toBe(true);

    const row = db
      .prepare(
        "SELECT target_weight_kg FROM goals WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { target_weight_kg: number };
    expect(row.target_weight_kg).toBe(100);
  });
});
