// SERVER-ACTION TIER — Fitness check write path (#834).
//
// Drives saveFitnessTest / setFitnessCadence through the real actions against the
// in-memory DB. Proves values land in their NATURAL stores (medical_records vitals,
// body_metrics, exercise_sets on the assessment activity) and the session + coverage
// ledger group them, and that the auth boundary + revalidate fire.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  saveFitnessTest,
  setFitnessCadence,
} from "@/app/(app)/training/fitness-actions";
import { getFitnessRetestCadenceDays } from "@/lib/settings";
import { estimate1RM } from "@/lib/strength";
import { seedActor, fd, type TestProfile } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// Give the profile a sex + birthdate so the norms/age-dependent paths resolve.
function setDemographics(profileId: number, sex: string, birthdate: string) {
  const ins = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value"
  );
  ins.run(profileId, "sex", sex);
  ins.run(profileId, "birthdate", birthdate);
}

function medRows(profileId: number, canonical: string) {
  return db
    .prepare(
      "SELECT date, category, canonical_name, value_num, unit, source FROM medical_records WHERE profile_id = ? AND canonical_name = ? ORDER BY id"
    )
    .all(profileId, canonical) as any[];
}
function sessionRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, date, activity_id FROM fitness_assessments WHERE profile_id = ?"
    )
    .all(profileId) as any[];
}
function entryRows(assessmentId: number) {
  return db
    .prepare(
      "SELECT test_key, tier, store, value, unit, raw_input FROM fitness_assessment_entries WHERE assessment_id = ? ORDER BY test_key"
    )
    .all(assessmentId) as any[];
}
function setRows(activityId: number) {
  return db
    .prepare(
      "SELECT exercise, reps, weight_kg, duration_sec FROM exercise_sets WHERE activity_id = ? ORDER BY id"
    )
    .all(activityId) as any[];
}

const DATE = "2026-03-01";

describe("saveFitnessTest — natural-store routing", () => {
  it("writes a vital test (grip) to medical_records and records the session entry", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    const r = await saveFitnessTest(
      fd({ testKey: "grip", value: 48, date: DATE })
    );
    expect(r.ok).toBe(true);
    const meds = medRows(profile.id, "Grip Strength");
    expect(meds).toHaveLength(1);
    expect(meds[0].value_num).toBe(48);
    expect(meds[0].category).toBe("vitals");
    expect(meds[0].source).toBe("manual");
    const sessions = sessionRows(profile.id);
    expect(sessions).toHaveLength(1);
    const entries = entryRows(sessions[0].id);
    expect(entries).toHaveLength(1);
    expect(entries[0].test_key).toBe("grip");
    expect(entries[0].store).toBe("vital");
    expect(entries[0].value).toBe(48);
    expect(revalidate).toHaveBeenCalledWith("/training");
  });

  it("writes a rep test (push-ups) as a set on the assessment activity", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(fd({ testKey: "pushups", value: 30, date: DATE }));
    const session = sessionRows(profile.id)[0];
    expect(session.activity_id).not.toBeNull();
    const activity = db
      .prepare("SELECT type, title FROM activities WHERE id = ?")
      .get(session.activity_id) as any;
    expect(activity.type).toBe("strength");
    expect(activity.title).toBe("Fitness check");
    const sets = setRows(session.activity_id);
    expect(sets).toHaveLength(1);
    expect(sets[0].exercise).toBe("Push Up");
    expect(sets[0].reps).toBe(30);
  });

  it("writes a timed test (plank) as a duration set", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "female", "1990-01-01");
    await saveFitnessTest(fd({ testKey: "plank", value: 95, date: DATE }));
    const session = sessionRows(profile.id)[0];
    const sets = setRows(session.activity_id);
    expect(sets[0].exercise).toBe("Plank");
    expect(sets[0].duration_sec).toBe(95);
    expect(sets[0].reps).toBeNull();
  });

  it("writes body fat to body_metrics", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(fd({ testKey: "bodyfat", value: 18, date: DATE }));
    const bm = db
      .prepare(
        "SELECT weight_kg, body_fat_pct FROM body_metrics WHERE profile_id = ? ORDER BY id"
      )
      .all(profile.id) as any[];
    expect(bm).toHaveLength(1);
    expect(bm[0].body_fat_pct).toBe(18);
    expect(bm[0].weight_kg).toBeNull();
  });

  it("merges two body tests on one date into a single body_metrics row (UNIQUE date+source)", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(fd({ testKey: "bodyfat", value: 18, date: DATE }));
    await saveFitnessTest(fd({ testKey: "restinghr", value: 55, date: DATE }));
    const bm = db
      .prepare(
        "SELECT body_fat_pct, resting_hr FROM body_metrics WHERE profile_id = ? AND date = ?"
      )
      .all(profile.id, DATE) as any[];
    expect(bm).toHaveLength(1);
    expect(bm[0].body_fat_pct).toBe(18);
    expect(bm[0].resting_hr).toBe(55);
  });

  it("derives VO2 from a Cooper field test and stores it as the VO2 Max biomarker", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    const r = await saveFitnessTest(
      fd({
        testKey: "vo2max",
        method: "cooper",
        distanceMeters: 2400,
        date: DATE,
      })
    );
    expect(r.ok).toBe(true);
    const meds = medRows(profile.id, "VO2 Max");
    expect(meds).toHaveLength(1);
    expect(meds[0].value_num).toBeCloseTo(42.4, 1);
    expect(meds[0].category).toBe("biomarker");
    const entry = entryRows(sessionRows(profile.id)[0].id)[0];
    expect(JSON.parse(entry.raw_input).method).toBe("cooper");
  });

  it("estimates e1RM from a big lift's weight×reps and places it as a loaded set", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(
      fd({
        testKey: "biglift",
        lift: "Back Squat",
        weight: 120,
        reps: 3,
        date: DATE,
      })
    );
    const session = sessionRows(profile.id)[0];
    const sets = setRows(session.activity_id);
    expect(sets[0].exercise).toBe("Back Squat");
    expect(sets[0].weight_kg).toBe(120);
    expect(sets[0].reps).toBe(3);
    const entry = entryRows(session.id)[0];
    expect(entry.value).toBeCloseTo(estimate1RM(120, 3), 3);
  });
});

describe("saveFitnessTest — session grouping + re-entry", () => {
  it("groups multiple tests on a date into ONE session (partial completion)", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(fd({ testKey: "grip", value: 48, date: DATE }));
    await saveFitnessTest(fd({ testKey: "balance", value: 30, date: DATE }));
    const sessions = sessionRows(profile.id);
    expect(sessions).toHaveLength(1);
    expect(entryRows(sessions[0].id)).toHaveLength(2);
  });

  it("re-entering a set test replaces the set in place (no stacking)", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    await saveFitnessTest(fd({ testKey: "pushups", value: 30, date: DATE }));
    await saveFitnessTest(fd({ testKey: "pushups", value: 34, date: DATE }));
    const session = sessionRows(profile.id)[0];
    const sets = setRows(session.activity_id);
    expect(sets).toHaveLength(1);
    expect(sets[0].reps).toBe(34);
    expect(entryRows(session.id)).toHaveLength(1);
  });
});

describe("saveFitnessTest — outcome + finding closure (#1305/#1307)", () => {
  it("returns the per-test outcome moment (percentile/value)", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    const r = await saveFitnessTest(
      fd({ testKey: "grip", value: 48, date: today(profile.id) })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.outcome?.key).toBe("grip");
      expect(r.outcome?.valueText).toContain("48");
    }
  });

  it("toasts the retest-clock refresh when the save clears the overdue check finding", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    // Seed an overdue prior check (>90-day default) so the retest finding is active.
    db.prepare(
      "INSERT INTO fitness_assessments (profile_id, date) VALUES (?, ?)"
    ).run(profile.id, shiftDateStr(today(profile.id), -120));
    const r = await saveFitnessTest(
      fd({ testKey: "grip", value: 48, date: today(profile.id) })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closureToast).toContain("retest clock restarts");
  });

  it("toasts nothing when the save clears no finding (the common case)", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    const r = await saveFitnessTest(
      fd({ testKey: "grip", value: 48, date: today(profile.id) })
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closureToast).toBeNull();
  });
});

describe("saveFitnessTest — validation", () => {
  it("rejects an unknown test and a VO2 with no field inputs", async () => {
    const { profile } = seedActor();
    setDemographics(profile.id, "male", "1985-06-01");
    expect((await saveFitnessTest(fd({ testKey: "nope", value: 1 }))).ok).toBe(
      false
    );
    expect(
      (
        await saveFitnessTest(
          fd({ testKey: "vo2max", method: "cooper", date: DATE })
        )
      ).ok
    ).toBe(false);
  });
});

describe("setFitnessCadence", () => {
  it("stores the per-profile retest cadence", async () => {
    const { profile }: { profile: TestProfile } = seedActor();
    const r = await setFitnessCadence(fd({ days: 120 }));
    expect(r.ok).toBe(true);
    expect(getFitnessRetestCadenceDays(profile.id)).toBe(120);
    expect(revalidate).toHaveBeenCalledWith("/training");
  });

  it("rejects a non-positive cadence", async () => {
    seedActor();
    expect((await setFitnessCadence(fd({ days: 0 }))).ok).toBe(false);
  });
});
