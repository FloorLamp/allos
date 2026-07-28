// SERVER-ACTION TIER — the combined "Log measurements" write path (#1486).
//
// The Body and Vitals tabs each had their own quick-add; #1486 merged the tab AND
// its form, so ONE action now composes the three existing write cores. These tests
// drive the real action against the in-memory DB and pin:
//
//   • a mixed submission lands in ALL THREE stores (body_metrics, medical_records
//     vitals, metric_samples) from one post;
//   • a partial submission writes only the half it carries (the whole point of a
//     form where every field is optional);
//   • the auth boundary + revalidate fire;
//   • the CADENCE RULE: the three #158 functional-fitness markers are NOT reachable
//     from the daily measurements form, while the guided Fitness check on /training
//     still produces the SAME canonical medical_records row it always did. That
//     pairing is the whole risk of the relocation — "the entry surface moved,
//     storage did not" has to be a test, not a claim.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { saveFitnessTest } from "@/app/(app)/training/fitness-actions";
import { actAs, createLogin, createProfile, seedActor, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const DATE = "2026-05-04";

function bodyRows(profileId: number) {
  return db
    .prepare(
      "SELECT date, weight_kg, body_fat_pct, resting_hr, notes FROM body_metrics WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as {
    date: string;
    weight_kg: number;
    body_fat_pct: number | null;
    resting_hr: number | null;
    notes: string | null;
  }[];
}
function medRows(profileId: number, canonical: string) {
  return db
    .prepare(
      "SELECT date, category, canonical_name, value_num, unit, source, notes FROM medical_records WHERE profile_id = ? AND canonical_name = ? ORDER BY id"
    )
    .all(profileId, canonical) as {
    date: string;
    category: string;
    canonical_name: string;
    value_num: number;
    unit: string;
    source: string;
    notes: string | null;
  }[];
}
function sampleValue(profileId: number, metric: string): number | undefined {
  return (
    db
      .prepare(
        "SELECT value FROM metric_samples WHERE profile_id = ? AND metric = ? AND source = 'manual'"
      )
      .get(profileId, metric) as { value: number } | undefined
  )?.value;
}

describe("addMeasurements — one form, three stores", () => {
  it("writes body composition, vitals and growth from a single submission", async () => {
    const { profile } = seedActor();
    await addMeasurements(
      fd({
        date: DATE,
        weight: "80",
        weight_unit: "kg",
        body_fat_pct: "18.5",
        resting_hr: "54",
        notes: "morning",
        systolic: "118",
        diastolic: "76",
        spo2: "97",
        temperature: "98.6",
        temp_unit: "F",
        temp_time: "07:30",
        sleep_hours: "7.5",
        hrv: "42",
        height: "180",
        height_unit: "cm",
      })
    );

    // body_metrics
    expect(bodyRows(profile.id)).toEqual([
      {
        date: DATE,
        weight_kg: 80,
        body_fat_pct: 18.5,
        resting_hr: 54,
        notes: "morning",
      },
    ]);

    // medical_records — the SAME canonical names/units the Health Connect parser
    // writes, so a manual reading shares the charts + reference-range flags.
    expect(medRows(profile.id, "Blood Pressure Systolic")[0]).toMatchObject({
      date: DATE,
      category: "vitals",
      value_num: 118,
      unit: "mmHg",
      source: "manual",
    });
    expect(medRows(profile.id, "Blood Pressure Diastolic")[0].value_num).toBe(
      76
    );
    expect(medRows(profile.id, "Oxygen Saturation")[0].value_num).toBe(97);
    // The #800/#843 fever-curve time still rides the row's note.
    expect(medRows(profile.id, "Body Temperature")[0]).toMatchObject({
      value_num: 98.6,
      unit: "degF",
      notes: "07:30",
    });

    // metric_samples — sleep (minutes) + HRV + the growth height.
    expect(sampleValue(profile.id, "sleep_min")).toBe(450);
    expect(sampleValue(profile.id, "hrv_ms")).toBe(42);
    expect(sampleValue(profile.id, "height_cm")).toBe(180);

    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("writes only the half a partial submission carries", async () => {
    const { profile } = seedActor();
    // Vitals only — no weight, so no body_metrics row is invented.
    await addMeasurements(fd({ date: DATE, systolic: "120", diastolic: "80" }));
    expect(bodyRows(profile.id)).toEqual([]);
    expect(medRows(profile.id, "Blood Pressure Systolic")).toHaveLength(1);

    // Weight only — no vitals rows.
    await addMeasurements(fd({ date: DATE, weight: "70", weight_unit: "kg" }));
    expect(bodyRows(profile.id)).toHaveLength(1);
    expect(medRows(profile.id, "Oxygen Saturation")).toHaveLength(0);
  });

  it("writes body fat and resting HR independently from metric detail forms", async () => {
    const { profile } = seedActor();
    await addMeasurements(fd({ date: DATE, body_fat_pct: "18.5" }));
    await addMeasurements(fd({ date: DATE, resting_hr: "54" }));

    expect(bodyRows(profile.id)).toEqual([
      {
        date: DATE,
        weight_kg: null,
        body_fat_pct: 18.5,
        resting_hr: null,
        notes: null,
      },
      {
        date: DATE,
        weight_kg: null,
        body_fat_pct: null,
        resting_hr: 54,
        notes: null,
      },
    ]);
  });

  it("is a no-op (and does not revalidate) on an empty or invalid submission", async () => {
    const { profile } = seedActor();
    await addMeasurements(fd({ date: DATE }));
    expect(bodyRows(profile.id)).toEqual([]);
    expect(revalidate).not.toHaveBeenCalled();

    // A systolic without its diastolic is rejected by the shared pure guard.
    await addMeasurements(fd({ date: DATE, systolic: "120" }));
    expect(medRows(profile.id, "Blood Pressure Systolic")).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("refuses a read-only acting session", async () => {
    const login = createLogin();
    const profile = createProfile("Read only", login.id);
    actAs(login, profile, "read");
    await expect(
      addMeasurements(fd({ date: DATE, weight: "80", weight_unit: "kg" }))
    ).rejects.toThrow();
  });
});

describe("the cadence rule: functional-fitness markers moved, storage did not", () => {
  it("ignores the retired marker fields on the daily measurements form", async () => {
    const { profile } = seedActor();
    // The form no longer RENDERS these, and the action no longer reads them — a
    // hand-crafted post carrying them must not sneak an assessment-cadence value in
    // through the daily door.
    await addMeasurements(
      fd({
        date: DATE,
        weight: "80",
        weight_unit: "kg",
        grip_strength: "48",
        chair_stand: "16",
        balance: "30",
      })
    );
    expect(medRows(profile.id, "Grip Strength")).toHaveLength(0);
    expect(medRows(profile.id, "30-Second Chair Stand")).toHaveLength(0);
    expect(medRows(profile.id, "Single-Leg Balance")).toHaveLength(0);
  });

  it("still produces the same canonical rows from the training assessment flow", async () => {
    const { profile } = seedActor();
    const set = db.prepare(
      "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
    );
    set.run(profile.id, "sex", "male");
    set.run(profile.id, "birthdate", "1985-06-01");

    for (const [testKey, value] of [
      ["grip", 48],
      ["chairstand", 16],
      ["balance", 30],
    ] as const) {
      const r = await saveFitnessTest(fd({ testKey, value, date: DATE }));
      expect(r.ok).toBe(true);
    }

    // Byte-for-byte the rows the old vitals quick-add wrote: same canonical names,
    // same 'vitals' category, same units, same manual source.
    expect(medRows(profile.id, "Grip Strength")[0]).toMatchObject({
      date: DATE,
      category: "vitals",
      value_num: 48,
      unit: "kg",
      source: "manual",
    });
    expect(medRows(profile.id, "30-Second Chair Stand")[0]).toMatchObject({
      category: "vitals",
      value_num: 16,
      unit: "reps",
    });
    expect(medRows(profile.id, "Single-Leg Balance")[0]).toMatchObject({
      category: "vitals",
      value_num: 30,
      unit: "seconds",
    });
  });
});
