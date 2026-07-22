// DB INTEGRATION TIER (#834). Proves the Fitness-check write core lands values in their
// NATURAL stores and that EXISTING consumers pick them up with zero changes — a check
// improves healthspan-pillar coverage (the VO2 pillar appears only after the check feeds
// a VO2 Max reading). Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  saveFitnessEntry,
  getFitnessAssessments,
  getLatestFitnessAssessmentDate,
  getAmbientFitnessReadings,
} from "@/lib/fitness-assessment";
import { batteryForAge } from "@/lib/fitness-battery";
import { buildFitnessCheckModel } from "@/lib/fitness-check-model";
import { getHealthspanPillars } from "@/lib/queries";
import { addCanonicalNames } from "@/lib/queries/medical";

function makeAdult(name: string, sex = "male", birthdate = "1985-06-01") {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  const ins = db.prepare(
    "INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)"
  );
  ins.run(profileId, "sex", sex);
  ins.run(profileId, "birthdate", birthdate);
  return { profileId, anchor: today(profileId) };
}

describe("fitness check improves healthspan-pillar coverage", () => {
  it("adds the VO2 pillar only after a check feeds a VO2 Max reading", () => {
    const { profileId, anchor } = makeAdult("pillar-coverage");

    // Before: no VO2 reading → no VO2 pillar.
    const before = getHealthspanPillars(profileId);
    expect(before.some((p) => p.key === "vo2max")).toBe(false);

    // A check records VO2 Max through its natural store (medical_records biomarker).
    const r = saveFitnessEntry(profileId, {
      date: anchor,
      testKey: "vo2max",
      value: 44,
      rawInput: { method: "watch", watchValue: 44 },
    });
    expect(r.ok).toBe(true);

    // After: the SAME healthspan query — unchanged — now surfaces the VO2 pillar.
    const after = getHealthspanPillars(profileId);
    expect(after.some((p) => p.key === "vo2max")).toBe(true);
  });
});

describe("fitness-assessment session model", () => {
  it("groups a date's tests into one session with a coverage ledger", () => {
    const { profileId, anchor } = makeAdult("session-model");
    saveFitnessEntry(profileId, { date: anchor, testKey: "grip", value: 48 });
    saveFitnessEntry(profileId, {
      date: anchor,
      testKey: "pushups",
      value: 30,
      reps: 30,
    });
    saveFitnessEntry(profileId, {
      date: anchor,
      testKey: "biglift",
      value: 150,
      liftName: "Back Squat",
      weightKg: 120,
      reps: 3,
      rawInput: { lift: "Back Squat", weightKg: 120, reps: 3 },
    });

    const sessions = getFitnessAssessments(profileId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].date).toBe(anchor);
    const keys = sessions[0].entries.map((e) => e.testKey).sort();
    expect(keys).toEqual(["biglift", "grip", "pushups"]);
    // The set-based tests share ONE assessment activity.
    const grip = sessions[0].entries.find((e) => e.testKey === "grip")!;
    expect(grip.store).toBe("vital");
    const big = sessions[0].entries.find((e) => e.testKey === "biglift")!;
    expect(big.store).toBe("set");
    expect((big.rawInput as { lift: string }).lift).toBe("Back Squat");

    expect(getLatestFitnessAssessmentDate(profileId)).toBe(anchor);
  });

  it("reads sessions newest-first for check-over-check deltas", () => {
    const { profileId, anchor } = makeAdult("delta-order");
    // An older and a newer session (distinct dates → distinct sessions).
    const older = "2026-01-01";
    saveFitnessEntry(profileId, { date: older, testKey: "grip", value: 44 });
    saveFitnessEntry(profileId, { date: anchor, testKey: "grip", value: 48 });
    const sessions = getFitnessAssessments(profileId);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].date).toBe(anchor); // newest first
    expect(getLatestFitnessAssessmentDate(profileId)).toBe(anchor);
  });

  it("is profile-scoped — one profile's sessions never leak into another's", () => {
    const a = makeAdult("scope-a");
    const b = makeAdult("scope-b");
    saveFitnessEntry(a.profileId, {
      date: a.anchor,
      testKey: "grip",
      value: 48,
    });
    expect(getFitnessAssessments(b.profileId)).toHaveLength(0);
    expect(getLatestFitnessAssessmentDate(b.profileId)).toBeNull();
  });
});

// ── #1129: ambient natural-store read-back → auto-count ──────────────────────────
// The bug class lives in the GATHER (#448): a synced VO2 must auto-count; a stale reading
// must be labeled; an in-session entry must still win. These seed the natural stores
// DIRECTLY (no check session) and assert the end-to-end model.
function seedVital(
  profileId: number,
  canonical: string,
  valueNum: number,
  date: string,
  source: string
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, value_num, unit, canonical_name, source)
     VALUES (?, ?, 'biomarker', ?, ?, ?, 'mL/kg/min', ?, ?)`
  ).run(
    profileId,
    date,
    canonical,
    String(valueNum),
    valueNum,
    canonical,
    source
  );
  addCanonicalNames([canonical]);
}
function seedBody(
  profileId: number,
  date: string,
  source: string,
  cols: { body_fat_pct?: number; resting_hr?: number; weight_kg?: number }
) {
  db.prepare(
    `INSERT INTO body_metrics (date, weight_kg, body_fat_pct, resting_hr, source, profile_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    date,
    cols.weight_kg ?? null,
    cols.body_fat_pct ?? null,
    cols.resting_hr ?? null,
    source,
    profileId
  );
}
function seedSet(
  profileId: number,
  date: string,
  exercise: string,
  fields: { weight_kg?: number; reps?: number; duration_sec?: number },
  source: string | null = null
) {
  const activityId = Number(
    db
      .prepare(
        "INSERT INTO activities (date, type, title, profile_id, source) VALUES (?, 'strength', 'Journal', ?, ?)"
      )
      .run(date, profileId, source).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO exercise_sets (activity_id, exercise, set_number, weight_kg, reps, duration_sec, warmup)
     VALUES (?, ?, 1, ?, ?, ?, 0)`
  ).run(
    activityId,
    exercise,
    fields.weight_kg ?? null,
    fields.reps ?? null,
    fields.duration_sec ?? null
  );
}

function ambientModel(
  profileId: number,
  anchor: string,
  cadence = 180,
  bw: number | null = 80
) {
  const battery = batteryForAge(40);
  const ambient = getAmbientFitnessReadings(profileId, battery);
  const sessions = getFitnessAssessments(profileId);
  return buildFitnessCheckModel(
    battery,
    sessions,
    ambient,
    "male",
    40,
    bw,
    anchor,
    cadence
  );
}

describe("#1129 ambient auto-count from the natural stores", () => {
  it("auto-counts a synced VO2, a scale body-fat/RHR, and a logged squat — with source labels", () => {
    const { profileId, anchor } = makeAdult("ambient-autocount");
    const recent = shiftDateStr(anchor, -3);
    seedVital(profileId, "VO2 Max", 48, recent, "oura");
    seedBody(profileId, recent, "withings", {
      body_fat_pct: 18,
      resting_hr: 55,
      weight_kg: 80,
    });
    seedSet(profileId, recent, "Back Squat", { weight_kg: 140, reps: 3 });

    const m = ambientModel(profileId, anchor);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.measured).toBe(true);
    expect(vo2.value).toBe(48);
    expect(vo2.percentile).not.toBeNull();
    expect(vo2.provenance!.kind).toBe("synced");
    expect(vo2.provenance!.sourceName).toBe("Oura");
    expect(vo2.provenance!.stale).toBe(false);

    const bf = m.results.find((r) => r.key === "bodyfat")!;
    expect(bf.measured).toBe(true);
    expect(bf.value).toBe(18);
    expect(bf.provenance!.kind).toBe("synced");
    expect(bf.provenance!.sourceName).toBe("Withings");

    const rhr = m.results.find((r) => r.key === "restinghr")!;
    expect(rhr.measured).toBe(true);
    expect(rhr.value).toBe(55);

    const big = m.results.find((r) => r.key === "biglift")!;
    expect(big.measured).toBe(true);
    expect(big.standingLift).toBe("Back Squat");
    expect(big.standing).not.toBeNull();
    expect(big.provenance!.kind).toBe("logged");

    // Coverage counts ambient tests with no check session.
    expect(m.measuredCount).toBeGreaterThanOrEqual(4);
  });

  it("labels an out-of-cadence-window logged set STALE (measured, not silently counted)", () => {
    const { profileId, anchor } = makeAdult("ambient-stale");
    const old = shiftDateStr(anchor, -400);
    seedSet(profileId, old, "Push Up", { reps: 30 });

    const m = ambientModel(profileId, anchor, 180);
    const pushups = m.results.find((r) => r.key === "pushups")!;
    expect(pushups.measured).toBe(true);
    expect(pushups.value).toBe(30);
    expect(pushups.provenance!.stale).toBe(true);
    expect(pushups.provenance!.ageDays!).toBeGreaterThan(180);
  });

  it("a fresh check entry overrides an older ambient reading (newest wins)", () => {
    const { profileId, anchor } = makeAdult("ambient-override");
    const old = shiftDateStr(anchor, -30);
    seedVital(profileId, "VO2 Max", 42, old, "oura");
    // A check today writes a NEWER VO2 through to the same store.
    saveFitnessEntry(profileId, {
      date: anchor,
      testKey: "vo2max",
      value: 50,
      rawInput: { method: "watch", watchValue: 50 },
    });

    const m = ambientModel(profileId, anchor);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.value).toBe(50); // the fresh check wins, not the older synced 42
    expect(vo2.provenance!.kind).toBe("check");
    // No double count: exactly one VO2 result, measured once.
    expect(m.results.filter((r) => r.key === "vo2max")).toHaveLength(1);
  });

  it("reads the set-store dead hang back as a self-norm ambient value", () => {
    const { profileId, anchor } = makeAdult("ambient-hold");
    const recent = shiftDateStr(anchor, -5);
    seedSet(profileId, recent, "Dead Hang", { duration_sec: 90 });

    const m = ambientModel(profileId, anchor);
    const dh = m.results.find((r) => r.key === "deadhang")!;
    expect(dh.measured).toBe(true);
    expect(dh.value).toBe(90);
    expect(dh.tier).toBe("self-norm");
    expect(dh.selfNorm!.band).toBe("good"); // 90s male → good
    expect(dh.selfNorm!.quality).toBe("rough");
  });
});
