// DB INTEGRATION TIER (#834). Proves the Fitness-check write core lands values in their
// NATURAL stores and that EXISTING consumers pick them up with zero changes — a check
// improves healthspan-pillar coverage (the VO2 pillar appears only after the check feeds
// a VO2 Max reading). Runs via `npm run test:db`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  saveFitnessEntry,
  getFitnessAssessments,
  getLatestFitnessAssessmentDate,
} from "@/lib/fitness-assessment";
import { getHealthspanPillars } from "@/lib/queries";

function makeAdult(name: string, sex = "male", birthdate = "1985-06-01") {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name).lastInsertRowid
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
    saveFitnessEntry(profileId, { date: anchor, testKey: "pushups", value: 30, reps: 30 });
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
    saveFitnessEntry(a.profileId, { date: a.anchor, testKey: "grip", value: 48 });
    expect(getFitnessAssessments(b.profileId)).toHaveLength(0);
    expect(getLatestFitnessAssessmentDate(b.profileId)).toBeNull();
  });
});
