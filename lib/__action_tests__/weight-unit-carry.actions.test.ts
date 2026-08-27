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
import {
  saveActivity,
  logBodyweight,
} from "@/app/(app)/training/activity-actions";
import { createGoal } from "@/app/(app)/training/goal-actions";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { updateMetricReading } from "@/app/(app)/trends/reading-actions";
import { paletteQuickLog } from "@/app/(app)/palette-actions";
import { readingTargetToken } from "@/lib/reading-placement";
import { LB_PER_KG } from "@/lib/units";
import { setStoredAge } from "@/lib/settings";
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
    setStoredAge(profile.id, 30);

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
    setStoredAge(profile.id, 30);

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
    setStoredAge(profile.id, 30);

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

// The dashboard weight quick-add's payload shape (#2863) — the three fields
// components/dashboard/WeightQuickAdd.tsx posts, which until now omitted the unit and
// let a Settings flip between render and submit re-interpret a correctly-typed
// weigh-in. That the form carries the field is pinned in
// components/__tests__/weight-quick-add-unit.test.tsx; this is what carrying it BUYS.
describe("addBodyMetric honors the submitted weight unit (issues #630, #2863)", () => {
  it.each([
    // typed under a (kg) label; 82 kg is 180.8 lb, so a pref-read write would have
    // stored 37.2 kg — the 2.2046× corruption the carried unit prevents.
    { submitted: "kg", stored: "lb", typed: 82, expectKg: 82 },
    { submitted: "lb", stored: "kg", typed: 180, expectKg: 180 / LB_PER_KG },
    // No field at all (older client, other callers): the fallback is the contract.
    { submitted: null, stored: "lb", typed: 180, expectKg: 180 / LB_PER_KG },
  ] as const)(
    "stores $typed submitted as $submitted with the login pref on $stored",
    async ({ submitted, stored, typed, expectKg }) => {
      const login = createLogin({ weightUnit: stored });
      const profile = createProfile(
        `dash-${submitted ?? "none"}-${stored}`,
        login.id
      );
      actAs(login, profile);

      await addBodyMetric(
        fd({ date: "2026-07-01", weight: typed, weight_unit: submitted })
      );

      const row = db
        .prepare(
          "SELECT weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
        )
        .get(profile.id) as { weight_kg: number };
      expect(row.weight_kg).toBeCloseTo(expectKg, 6);
    }
  );
});

// THE CORRECTION PATH AND THE PALETTE (#3853), the two write paths that still
// re-read the pref after #3850 closed the dashboard's.
//
// Both are seeded with the login's STORED pref set OPPOSITE to the captured unit, so a
// pref-reading write is off by 2.2046× and the assertion cannot pass by coincidence.
// A correction is the worse of the two to get wrong: the person is already looking at
// the number because they thought it was wrong, so a silent 2.2× "fix" is the one
// they are likeliest to accept.

function weightRowKg(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profileId) as { weight_kg: number }
  ).weight_kg;
}

describe("updateMetricReading honors the submitted weight unit (issues #630, #3853)", () => {
  it.each([
    { submitted: "kg", stored: "lb", entered: 82, expectKg: 82 },
    { submitted: "lb", stored: "kg", entered: 180, expectKg: 180 / LB_PER_KG },
    // Field absent (an older client): the pref remains the documented fallback.
    { submitted: null, stored: "lb", entered: 180, expectKg: 180 / LB_PER_KG },
  ] as const)(
    "corrects to $entered $submitted with the login pref on $stored",
    async ({ submitted, stored, entered, expectKg }) => {
      const login = createLogin({ weightUnit: stored });
      const profile = createProfile(`fix-${submitted ?? "none"}-${stored}`);
      actAs(login, profile);
      const id = Number(
        db
          .prepare(
            "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
          )
          .run(profile.id, "2026-07-01", 70).lastInsertRowid
      );

      const res = await updateMetricReading(
        fd({
          kind: "weight",
          target: readingTargetToken({
            store: "body_metrics",
            id,
            column: "weight_kg",
          }),
          value: entered,
          weight_unit: submitted,
        })
      );

      expect([res, weightRowKg(profile.id)]).toEqual([
        { ok: true },
        expect.closeTo(expectKg, 6),
      ]);
    }
  );
});

describe("paletteQuickLog honors the captured unit (issues #630, #3853)", () => {
  it.each([
    { captured: "kg", stored: "lb", input: "weight 82", expectKg: 82 },
    {
      captured: "lb",
      stored: "kg",
      input: "weight 180",
      expectKg: 180 / LB_PER_KG,
    },
    // An explicit suffix is the person's own statement and outranks both.
    {
      captured: "kg",
      stored: "kg",
      input: "weight 180 lb",
      expectKg: 180 / LB_PER_KG,
    },
    { captured: undefined, stored: "lb", input: "weight 180", expectKg: 180 / LB_PER_KG },
  ] as const)(
    "commits `$input` previewed in $captured with the login pref on $stored",
    async ({ captured, stored, input, expectKg }) => {
      const login = createLogin({ weightUnit: stored });
      const profile = createProfile(`palette-${captured ?? "none"}-${stored}`);
      actAs(login, profile);

      expect(await paletteQuickLog(input, captured)).toMatchObject({ ok: true });
      expect(weightRowKg(profile.id)).toBeCloseTo(expectKg, 6);
    }
  );
});
