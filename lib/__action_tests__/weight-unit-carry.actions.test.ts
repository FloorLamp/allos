// SERVER-ACTION TIER — the captured-unit carry (issue #630).
//
// Weight/distance forms post the unit the value was CAPTURED in and the action
// honors it, rather than re-reading the login's stored pref at write time. This
// is the #467 compare-and-set principle generalized: a debounced auto-save (or a
// slow manual submit) can land after the login flipped its unit in another tab —
// re-reading the pref would then mis-convert a correctly-entered number. Here the
// login's STORED pref is deliberately the OPPOSITE of the submitted unit, so a
// pref-reading write would corrupt the value; the submitted unit must win.
//
// ONE case in this file ends differently, and it is the last describe: a bulk
// correction is a preview → apply PAIR of Server Actions, not a form post, so there
// is no captured unit to post. There the flip is REFUSED rather than honored
// (#3962) — same class, same 2.2046× corruption, a different product.

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
import { saveFitnessTest } from "@/app/(app)/training/fitness-actions";
import { createEndurancePlan } from "@/app/(app)/training/endurance-actions";
import { readingTargetToken } from "@/lib/reading-placement";
import { LB_PER_KG, MI_PER_KM } from "@/lib/units";
import { getUnitPrefs, setStoredAge, setUnitPrefs } from "@/lib/settings";
import { getEndurancePlans } from "@/lib/endurance-plans";
import {
  applyBulkCorrectionAction,
  previewBulkCorrection,
  type BulkCorrectionRequest,
} from "@/app/(app)/data/bulk-correction-actions";
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

// A quick weigh-in's payload shape (#2863) — the three fields a quick-add form posts,
// which until #2863 omitted the unit and let a Settings flip between render and submit
// re-interpret a correctly-typed weigh-in. The dashboard widget that first carried
// this shape retired with #3366's tail write cards; the surviving quick surface is
// app/(app)/trends/MeasurementsQuickAdd.tsx, which posts the same hidden
// `weight_unit`. This is what carrying it BUYS.
describe("addBodyMetric honors the submitted weight unit (issues #630, #2863)", () => {
  it.each([
    // typed under a (kg) label; 82 kg is 180.8 lb, so a pref-read write would have
    // stored 37.2 kg — the 2.2046× corruption the carried unit prevents.
    { submitted: "kg", stored: "lb", typed: 82, expectKg: 82 },
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
    // An explicit suffix is the person's own statement and outranks both.
    {
      captured: "kg",
      stored: "kg",
      input: "weight 180 lb",
      expectKg: 180 / LB_PER_KG,
    },
    {
      captured: undefined,
      stored: "lb",
      input: "weight 180",
      expectKg: 180 / LB_PER_KG,
    },
  ] as const)(
    "commits `$input` previewed in $captured with the login pref on $stored",
    async ({ captured, stored, input, expectKg }) => {
      const login = createLogin({ weightUnit: stored });
      const profile = createProfile(`palette-${captured ?? "none"}-${stored}`);
      actAs(login, profile);

      expect(await paletteQuickLog(input, captured)).toMatchObject({
        ok: true,
      });
      expect(weightRowKg(profile.id)).toBeCloseTo(expectKg, 6);
    }
  );
});

// THE FITNESS CHECK'S e1RM FIELD (#3942) — the third path #3874's sweep missed while
// its body said there were two. Unlike the cases above this one is driven through a
// GENUINE flip: the render-time read is the same getUnitPrefs call FitnessCheckSection
// makes, the pref is then rewritten as another tab would rewrite it, and only then does
// the action run. A pref-reading write stores 225 kg for a 225 lb bench, which then
// feeds estimate1RM, the fitness-check band, strengthStanding and the healthspan pillar.
describe("saveFitnessTest honors the unit the e1RM field rendered (issues #630, #3942)", () => {
  it.each([
    { rendered: "lb", flippedTo: "kg", typed: 225, expectKg: 225 / LB_PER_KG },
    // No field at all (older client): the pref AT WRITE TIME stays the documented
    // fallback, so the flip does land — that is the contract, not a defect.
    { rendered: null, flippedTo: "lb", typed: 225, expectKg: 225 / LB_PER_KG },
  ] as const)(
    "stores $typed typed under a ($rendered) label after the pref flips to $flippedTo",
    async ({ rendered, flippedTo, typed, expectKg }) => {
      const login = createLogin({ weightUnit: rendered ?? flippedTo });
      const profile = createProfile(
        `e1rm-${rendered ?? "none"}-${flippedTo}`,
        login.id
      );
      actAs(login, profile);
      setStoredAge(profile.id, 30);

      // Render: the section reads the pref and labels the field with it.
      const labelUnit = getUnitPrefs(login.id).weightUnit;
      if (rendered) expect(labelUnit).toBe(rendered);

      // …then the login flips its unit in another tab, before Save is pressed.
      setUnitPrefs(login.id, {
        weightUnit: flippedTo,
        distanceUnit: "km",
        temperatureUnit: "F",
      });

      const res = await saveFitnessTest(
        fd({
          testKey: "biglift",
          lift: "Bench Press",
          weight: typed,
          reps: 3,
          date: "2026-07-01",
          weight_unit: rendered,
        })
      );
      expect(res.ok).toBe(true);

      const row = db
        .prepare(
          `SELECT s.weight_kg FROM exercise_sets s
             JOIN activities a ON a.id = s.activity_id
            WHERE a.profile_id = ? ORDER BY s.id DESC LIMIT 1`
        )
        .get(profile.id) as { weight_kg: number };
      expect(row.weight_kg).toBeCloseTo(expectKg, 6);
    }
  );
});

// THE DISTANCE TWIN (#3942, folded in on the coordinator's ruling). The plan bar labels
// "Target distance (mi)" from a server prop and posted no unit, while both endurance
// actions re-read `distanceUnit` at write time — structurally identical to the e1RM field
// above, in the other unit family. Same genuine flip: the render-time read, the pref
// rewritten as another tab would, then the action.
describe("createEndurancePlan honors the unit the distance field rendered (issues #630, #3942)", () => {
  it.each([
    {
      rendered: "mi",
      flippedTo: "km",
      typed: 13.1,
      expectKm: 13.1 / MI_PER_KM,
    },
    // No field at all (older client): the pref AT WRITE TIME stays the fallback.
    {
      rendered: null,
      flippedTo: "mi",
      typed: 13.1,
      expectKm: 13.1 / MI_PER_KM,
    },
  ] as const)(
    "stores $typed typed under a ($rendered) label after the pref flips to $flippedTo",
    async ({ rendered, flippedTo, typed, expectKm }) => {
      const login = createLogin({ distanceUnit: rendered ?? flippedTo });
      const profile = createProfile(
        `plan-${rendered ?? "none"}-${flippedTo}`,
        login.id
      );
      actAs(login, profile);
      setStoredAge(profile.id, 30);

      // Render: the plan bar reads the pref and labels the field with it.
      const labelUnit = getUnitPrefs(login.id).distanceUnit;
      if (rendered) expect(labelUnit).toBe(rendered);

      // …then the login flips its unit in another tab, before Add plan is pressed.
      setUnitPrefs(login.id, {
        weightUnit: "kg",
        distanceUnit: flippedTo,
        temperatureUnit: "F",
      });

      const res = await createEndurancePlan(
        fd({
          discipline: "run",
          event_name: "City Half",
          event_date: "2026-10-05",
          target_distance: typed,
          distance_unit: rendered,
        })
      );
      expect(res.ok).toBe(true);
      expect(getEndurancePlans(profile.id)[0].targetDistanceKm).toBeCloseTo(
        expectKm,
        6
      );
    }
  );
});

// THE PREVIEW → APPLY PAIR (#3962) — the shape none of the carries above can reach.
// `previewBulkCorrection` resolves the typed amount under the login's unit and hands
// back a compare-and-set token; `applyBulkCorrectionAction` re-resolves it FRESH. The
// unit is per-login, so a flip in another tab between the two applies a correction
// 2.2046× off the one displayed — and the person is already looking at that number
// because they believe it is wrong, so it is the one they are likeliest to accept.
//
// The fix widens the token to sign the previewed plan's RESULTS as well as its rows,
// so the drift gate that already exists sees op drift. There is no second check: the
// same comparison that catches a sync landing mid-preview catches this. The third row
// is the converse — an op the unit cannot touch must still apply after a flip, or the
// guard is merely refusing everything.
describe("applyBulkCorrectionAction refuses an op re-resolved under a flipped unit (issues #630, #3962)", () => {
  function seedRun(profileId: number): void {
    for (const [date, kg] of [
      ["2026-03-01", 80],
      ["2026-03-02", 81.5],
    ] as const) {
      db.prepare(
        `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
         VALUES (?, ?, ?, 'withings')`
      ).run(profileId, date, kg);
    }
  }

  function storedKg(profileId: number): number[] {
    return (
      db
        .prepare(
          "SELECT weight_kg FROM body_metrics WHERE profile_id = ? ORDER BY date"
        )
        .all(profileId) as { weight_kg: number }[]
    ).map((r) => r.weight_kg);
  }

  it.each([
    // −2 typed under a (kg) label, re-resolved as −2 lb (−0.907 kg) at apply.
    {
      what: "an offset after a kg to lb flip",
      op: { kind: "add", value: -2 },
      flippedTo: "lb",
      applies: false,
      expectKg: [80, 81.5],
    },
    // Same op, same code path, no flip: the correction the preview showed lands.
    {
      what: "an offset with the unit unchanged",
      op: { kind: "add", value: -2 },
      flippedTo: "kg",
      applies: true,
      expectKg: [78, 79.5],
    },
    // A factor is unitless, so the flip changes nothing and refusing would be noise.
    {
      what: "a unitless factor after a kg to lb flip",
      op: { kind: "multiply", value: 0.5 },
      flippedTo: "lb",
      applies: true,
      expectKg: [40, 40.75],
    },
  ] as const)("$what", async ({ what, op, flippedTo, applies, expectKg }) => {
    const login = createLogin({ weightUnit: "kg" });
    const profile = createProfile(`bulkfix-${flippedTo}-${op.kind}`, login.id);
    actAs(login, profile);
    seedRun(profile.id);

    const request: BulkCorrectionRequest = {
      field: "weight",
      from: "2026-03-01",
      to: "2026-03-31",
      source: "withings",
      op,
    };
    // Preview: the amount is resolved under the unit the card labelled it with.
    expect(getUnitPrefs(login.id).weightUnit).toBe("kg");
    const preview = await previewBulkCorrection(request);
    if (!preview.ok) throw new Error(`preview refused: ${what}`);

    // …then the login flips its unit in another tab, before Apply is pressed.
    setUnitPrefs(login.id, {
      weightUnit: flippedTo,
      distanceUnit: "km",
      temperatureUnit: "F",
    });

    const res = await applyBulkCorrectionAction({
      ...request,
      signature: preview.signature,
    });
    expect(res.ok).toBe(applies);
    if (!res.ok) {
      // One gate, and it is the signature — the flip surfaces as drift, and the
      // sentence has to name the units setting or it sends the person hunting for
      // a sync that never landed.
      expect(res.error).toBe("drift");
      expect(res.message).toContain("units setting");
    }
    expect(storedKg(profile.id)).toEqual(expectKg);
  });
});
