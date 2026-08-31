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

import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  beforeAll,
  afterAll,
} from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { addMeasurements } from "@/app/(app)/trends/measurement-actions";
import { saveFitnessTest } from "@/app/(app)/training/fitness-actions";
import { getProteinAdequacy } from "@/lib/queries";
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
      "SELECT date, occurred_at, category, canonical_name, value_num, unit, source, notes FROM medical_records WHERE profile_id = ? AND canonical_name = ? ORDER BY id"
    )
    .all(profileId, canonical) as {
    date: string;
    occurred_at: string | null;
    category: string;
    canonical_name: string;
    value_num: number;
    unit: string;
    source: string;
    notes: string | null;
  }[];
}

// Deterministic acceptance-gate math whatever zone the host runs in: the stated
// instants below are on their row's day in UTC.
function pinUtc(profileId: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
  ).run(profileId);
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

// THE CLOCK IS PINNED so this file's dated fixtures stay in the PAST, and so the
// FUTURE-statement case below is deterministic. #4425's owner ruling gave every domain
// write core the same date invariant — any real past day, never the future — so the
// refused-statement fixture can no longer reach for a far-future DATE to make the
// `future` reason deterministic; it states a later hour of the pinned DAY instead,
// which is the shape a real fast device clock produces anyway.
const PINNED_NOW = "2026-05-20T09:00:00.000Z";
let priorNow: string | undefined;

beforeAll(() => {
  priorNow = process.env.ALLOS_TEST_NOW;
  process.env.ALLOS_TEST_NOW = PINNED_NOW;
});

afterAll(() => {
  if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
  else process.env.ALLOS_TEST_NOW = priorNow;
});

describe("addMeasurements — one form, three stores", () => {
  it("writes body composition, vitals and growth from a single submission", async () => {
    const { profile } = seedActor();
    pinUtc(profile.id);
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
    // This submission is the STALE PRE-FOLD CLIENT's shape (`temp_time`, no
    // occurred_at): its stated time lands on the row's own event column now
    // (#2154 — the retired #800/#843 note is never written again), resolved on
    // the profile's own wall clock.
    expect(medRows(profile.id, "Body Temperature")[0]).toMatchObject({
      value_num: 98.6,
      unit: "degF",
      occurred_at: `${DATE}T07:30:00Z`,
      notes: null,
    });
    // The legacy per-measure time reaches ONLY its own row.
    expect(
      medRows(profile.id, "Blood Pressure Systolic")[0].occurred_at
    ).toBeNull();

    // metric_samples — sleep (minutes) + HRV + the growth height.
    expect(sampleValue(profile.id, "sleep_min")).toBe(450);
    expect(sampleValue(profile.id, "hrv_ms")).toBe(42);
    expect(sampleValue(profile.id, "height_cm")).toBe(180);

    expect(revalidate).toHaveBeenCalledWith("/trends");
  });

  it("ignores empty or invalid submissions, then writes only populated halves", async () => {
    const { profile } = seedActor();

    await addMeasurements(fd({ date: DATE }));
    expect(bodyRows(profile.id)).toEqual([]);
    expect(revalidate).not.toHaveBeenCalled();

    // A systolic without its diastolic is rejected by the shared pure guard.
    await addMeasurements(fd({ date: DATE, systolic: "120" }));
    expect(medRows(profile.id, "Blood Pressure Systolic")).toHaveLength(0);
    expect(revalidate).not.toHaveBeenCalled();

    // Vitals only — no weight, so no body_metrics row is invented.
    await addMeasurements(fd({ date: DATE, systolic: "120", diastolic: "80" }));
    expect(bodyRows(profile.id)).toEqual([]);
    expect(medRows(profile.id, "Blood Pressure Systolic")).toHaveLength(1);

    // Weight only — no vitals rows.
    await addMeasurements(fd({ date: DATE, weight: "70", weight_unit: "kg" }));
    expect(bodyRows(profile.id)).toHaveLength(1);
    expect(medRows(profile.id, "Oxygen Saturation")).toHaveLength(0);
  });

  it("folds same-day body updates onto one row while preserving time semantics", async () => {
    // EDITED DELIBERATELY by #2235 (decision 6): this used to pin two stacked
    // manual rows, because the manual path was a plain INSERT the NULL-source
    // unique index could never dedupe. The manual core is find-then-write now —
    // the same shape, for the same reason, as lib/reading-writes.ts — so two
    // measures entered against one day share the day's manual row, and neither
    // blanks the other.
    const { profile } = seedActor();
    await addMeasurements(fd({ date: DATE, body_fat_pct: "18.5" }));
    await addMeasurements(fd({ date: DATE, resting_hr: "54" }));

    // The #2235 trichotomy over the real wire format: the form always posts
    // `occurred_at`, so "" is the user's explicit no-time (clears), a value is a
    // statement (normalized to the canonical shape), and a POST with no field at
    // all — a stale pre-#2235 client — makes no statement.
    const occurredAt = () =>
      (
        db
          .prepare(
            "SELECT occurred_at FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS NULL"
          )
          .get(profile.id, DATE) as { occurred_at: string | null }
      ).occurred_at;

    await addMeasurements(
      fd({
        date: DATE,
        weight: "70",
        weight_unit: "kg",
        occurred_at: `${DATE}T07:12:00.000Z`,
      })
    );
    expect(occurredAt()).toBe(`${DATE}T07:12:00Z`);

    // A stale client posts no occurred_at field: the statement survives.
    await addMeasurements(
      fd({ date: DATE, weight: "70.2", weight_unit: "kg" })
    );
    expect(occurredAt()).toBe(`${DATE}T07:12:00Z`);

    // The emptied Time on a submission that writes a value clears the column.
    await addMeasurements(
      fd({ date: DATE, weight: "70.4", weight_unit: "kg", occurred_at: "" })
    );
    expect(occurredAt()).toBeNull();
    expect(bodyRows(profile.id)).toEqual([
      {
        date: DATE,
        weight_kg: 70.4,
        body_fat_pct: 18.5,
        resting_hr: 54,
        notes: null,
      },
    ]);
  });

  it("carries the sitting's one Time onto every vitals observation (#2154)", async () => {
    // The fold: no per-measure time fields exist any more — the ONE posted
    // occurred_at is the whole sitting's statement, so a BP and a temperature
    // entered together share it, normalized to the canonical shape.
    const { profile } = seedActor();
    pinUtc(profile.id);
    await addMeasurements(
      fd({
        date: DATE,
        systolic: "122",
        diastolic: "81",
        temperature: "99.1",
        temp_unit: "F",
        occurred_at: `${DATE}T19:45:00.000Z`,
      })
    );
    for (const canonical of [
      "Blood Pressure Systolic",
      "Blood Pressure Diastolic",
      "Body Temperature",
    ]) {
      expect(medRows(profile.id, canonical)[0]).toMatchObject({
        occurred_at: `${DATE}T19:45:00Z`,
        notes: null,
      });
    }
    // An untimed sitting stores honest NULL — never a midnight anchor.
    await addMeasurements(
      fd({ date: DATE, systolic: "118", diastolic: "76", occurred_at: "" })
    );
    expect(
      medRows(profile.id, "Blood Pressure Systolic")[1].occurred_at
    ).toBeNull();
  });

  // #2311 — the online half of #2296's ruling, on the surface it had not reached.
  // The action ANSWERS the refusal so the form can say it; the measurements land
  // either way, because a refusal is a notice and not a validation failure.
  it("reports refused body and vitals times while keeping their readings (#2311, #2363)", async () => {
    const { profile } = seedActor();
    pinUtc(profile.id);

    // Off the row's own day — the rule the WhenControl pair makes unreachable from
    // a live form, and that a stale tab across local midnight still produces.
    expect(
      await addMeasurements(
        fd({
          date: DATE,
          weight: "72",
          weight_unit: "kg",
          occurred_at: `2026-05-05T07:00:00.000Z`,
        })
      )
    ).toEqual({ statedTimeRefused: "other-day" });
    expect(bodyRows(profile.id)).toEqual([
      {
        date: DATE,
        weight_kg: 72,
        body_fat_pct: null,
        resting_hr: null,
        notes: null,
      },
    ]);
    expect(
      (
        db
          .prepare(
            "SELECT occurred_at FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS NULL"
          )
          .get(profile.id, DATE) as { occurred_at: string | null }
      ).occurred_at
    ).toBeNull();

    // A device clock past the five-minute tolerance — the reproduction the issue
    // names. The tolerance does not move; the silence does.
    // A later hour of the pinned DAY rather than a far-future date: the row's own day
    // must be past for the core to take it at all (#4425), and a fast device clock
    // produces exactly this — today's row, an instant beyond the tolerance.
    const ahead = "2026-05-20";
    expect(
      await addMeasurements(
        fd({
          date: ahead,
          weight: "72.5",
          weight_unit: "kg",
          occurred_at: `${ahead}T12:00:00.000Z`,
        })
      )
    ).toEqual({ statedTimeRefused: "future" });

    // An ACCEPTED statement reports nothing at all — `unstated` and `accepted` are
    // both silence, and only a refusal is something to hear.
    expect(
      await addMeasurements(
        fd({
          date: DATE,
          weight: "72.8",
          weight_unit: "kg",
          occurred_at: `${DATE}T07:30:00.000Z`,
        })
      )
    ).toEqual({});
    expect(await addMeasurements(fd({ date: DATE, resting_hr: "51" }))).toEqual(
      {}
    );

    // #2363 — the survivor #2311's audit named. Nothing reaches the body half,
    // so the action must carry the vitals half's refusal answer itself.
    // No weight, no body fat, no resting HR — nothing reaches insertBodyMetric, so
    // this is exactly the case that used to be silent.
    expect(
      await addMeasurements(
        fd({
          date: DATE,
          systolic: "128",
          diastolic: "82",
          occurred_at: "2026-05-05T07:00:00.000Z",
        })
      )
    ).toEqual({ statedTimeRefused: "other-day" });
    // The reading landed on its own day with an honest NULL for the minute the gate
    // discarded — a notice, never a failure.
    expect(medRows(profile.id, "Blood Pressure Systolic")[0]).toMatchObject({
      occurred_at: null,
    });

    // A device clock past the five-minute tolerance, vitals-only.
    expect(
      await addMeasurements(
        fd({ date: ahead, spo2: "97", occurred_at: `${ahead}T12:00:00.000Z` })
      )
    ).toEqual({ statedTimeRefused: "future" });

    // Accepted and unstated are both silence on this half too.
    expect(
      await addMeasurements(
        fd({
          date: DATE,
          glucose: "92",
          glucose_unit: "mg/dL",
          occurred_at: `${DATE}T07:30:00.000Z`,
        })
      )
    ).toEqual({});
    expect(
      await addMeasurements(
        fd({ date: DATE, systolic: "119", diastolic: "78" })
      )
    ).toEqual({});
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
  it("ignores retired daily fields while preserving the assessment flow", async () => {
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

// ── #1851: three gaps the form could not take ────────────────────────────────
//
// Each of these drives the REAL action with the field names the form posts, and
// asserts the CANONICAL stored value — a field that renders and writes nothing
// passes any "the input exists" check, and a lean mass stored in pounds would
// scale the protein band by 2.2×. The composition half's whole point is the
// consumer, so the protein case asserts the BAND MOVES, not merely that a number
// was stored.

describe("addMeasurements — the #1851 manual-entry gaps", () => {
  it("stores the new fields canonically and corrects water instead of accumulating", async () => {
    const { profile } = seedActor();
    await addMeasurements(
      fd({
        date: DATE,
        hydration: "2.4",
        lean_mass: "130",
        lean_mass_unit: "lb",
        bone_mass: "2.9",
        bone_mass_unit: "kg",
        respiratory_rate: "22",
      })
    );

    expect(sampleValue(profile.id, "hydration_l")).toBe(2.4);
    // 130 lb is 58.97 kg — the number the chart, the passport and the protein
    // band all read. Storing 130 here would be the whole bug.
    expect(sampleValue(profile.id, "lean_mass_kg")).toBe(58.97);
    expect(sampleValue(profile.id, "bone_mass_kg")).toBe(2.9);
    expect(medRows(profile.id, "Respiratory Rate")[0]).toMatchObject({
      date: DATE,
      category: "vitals",
      value_num: 22,
      unit: "breaths/min",
      source: "manual",
    });
    expect(revalidate).toHaveBeenCalled();

    // Water is a daily total. Re-entry corrects the single point rather than
    // accumulating another 0.7 litres onto the existing 2.4.
    await addMeasurements(fd({ date: DATE, hydration: "0.7" }));
    expect(sampleValue(profile.id, "hydration_l")).toBe(0.7);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = 'hydration_l'"
        )
        .get(profile.id)
    ).toEqual({ n: 1 });
  });

  it("moves the protein band onto the lean basis a hand-entered DEXA figure gives it", async () => {
    const { profile } = seedActor();
    const anchor = today(profile.id);
    db.prepare(
      "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
    ).run(profile.id, anchor, 80);
    // An intake, so the adequacy gather has something to judge the band against.
    db.prepare(
      "INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, 'poultry', 2)"
    ).run(profile.id, anchor);

    const before = getProteinAdequacy(profile.id);
    expect(before?.target.massBasis).toBe("total");
    expect(before?.target.massKg).toBe(80);

    await addMeasurements(
      fd({ date: anchor, lean_mass: "56.4", lean_mass_unit: "kg" })
    );

    const after = getProteinAdequacy(profile.id);
    expect(after?.target.massBasis).toBe("lean");
    expect(after?.target.massKg).toBe(56.4);
    // The consumer this issue is about: the band itself moves, so the grams the
    // Food tab shows are scaled by lean mass rather than by total bodyweight.
    expect(after!.target.gramsLow).toBeLessThan(before!.target.gramsLow);
    expect(after!.target.gramsHigh).toBeLessThan(before!.target.gramsHigh);
  });
  // ALL FIVE CORES, ONE ANSWER (#4425 review). The sitting fans out across
  // `insertBodyMetric`, `insertVitals`, `insertGrowth`, `insertWaistCirc` and
  // `insertComposition`; when only the first two held the not-future invariant the
  // form wrote its tape reading and dropped its weigh-in — a PARTIAL sitting, under a
  // "Measurements saved" toast. The table names each store so a core that drifts back
  // says which one it was.
  it.each([
    ["body_metrics", (p: number) => bodyRows(p).length],
    [
      "medical_records",
      (p: number) => medRows(p, "Blood Pressure Systolic").length,
    ],
    [
      "height (growth)",
      (p: number) => (sampleValue(p, "height_cm") == null ? 0 : 1),
    ],
    [
      "waist (tape)",
      (p: number) => (sampleValue(p, "waist_circumference_cm") == null ? 0 : 1),
    ],
    [
      "lean mass (composition)",
      (p: number) => (sampleValue(p, "lean_mass_kg") == null ? 0 : 1),
    ],
  ])(
    "writes no %s row for a sitting dated after the profile's day",
    async (_store, count) => {
      const { profile } = seedActor();
      pinUtc(profile.id);
      const tomorrow = "2026-05-21";
      expect(tomorrow > today(profile.id)).toBe(true);

      await addMeasurements(
        fd({
          date: tomorrow,
          weight: "80",
          weight_unit: "kg",
          systolic: "118",
          diastolic: "76",
          height: "180",
          height_unit: "cm",
          waist_circ: "82",
          waist_circ_unit: "cm",
          lean_mass: "56",
          lean_mass_unit: "kg",
        })
      );

      expect(count(profile.id)).toBe(0);
    }
  );
});
