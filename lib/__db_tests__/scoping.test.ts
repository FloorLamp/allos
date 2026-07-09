// DB INTEGRATION TIER — runtime profile-scoping check (issue #160).
//
// lib/__tests__/profile-scoping.test.ts asserts the `profile_id` filter STATICALLY
// (a source scan of every owned-table .prepare). This file asserts the same
// invariant DYNAMICALLY: seed TWO profiles with distinct rows in a real DB, then
// execute representative scoped reads for profile A and prove none of profile B's
// rows leak in — including through a JOIN table (exercise_sets reaches profile_id
// via its parent activity). A wrong/missing WHERE profile_id that the source scan
// somehow allowed would surface here as B's data in A's result.

import { describe, it, expect, beforeAll } from "vitest";
import {
  getActivities,
  getStrengthByExercise,
  getGoals,
  getBodyMetrics,
  getMedicalRecords,
  getSupplements,
  getImmunizations,
  getImmunizationOverrides,
} from "@/lib/queries";
import type { Activity } from "@/lib/types";
import { seedProfile, type SeededProfile } from "./fixtures";

let a: SeededProfile;
let b: SeededProfile;

beforeAll(() => {
  // Distinct tags + values so B's rows are unmistakable inside A's result set.
  a = seedProfile("AAA", { weightKg: 70, glucoseValueNum: 90 });
  b = seedProfile("BBB", { weightKg: 111, glucoseValueNum: 200 });
});

describe("reads are scoped to the querying profile", () => {
  it("getActivities returns only profile A's activities", () => {
    const acts = getActivities(a.profileId);
    expect(acts.length).toBe(2);
    // profile_id is an infra column not on the domain Activity type — cast to read it.
    expect(
      acts.every(
        (x) =>
          (x as Activity & { profile_id: number }).profile_id === a.profileId
      )
    ).toBe(true);
    expect(acts.every((x) => x.title.startsWith("AAA"))).toBe(true);
    const ids = acts.map((x) => x.id);
    expect(ids).not.toContain(b.strengthActivityId);
    expect(ids).not.toContain(b.cardioActivityId);
  });

  it("getStrengthByExercise scopes through the exercise_sets → activities JOIN", () => {
    // Both profiles logged 'Back Squat' with two sets each. A leak would double
    // the count to 4; a correct JOIN-scoped read counts only A's two sets.
    const squatA = getStrengthByExercise(a.profileId).find(
      (s) => s.exercise === "Back Squat"
    );
    expect(squatA?.totalSets).toBe(2);
  });

  it("getBodyMetrics / getGoals / getSupplements return only A's rows", () => {
    expect(getBodyMetrics(a.profileId).every((m) => m.weight_kg === 70)).toBe(
      true
    );
    expect(getGoals(a.profileId).every((g) => g.title.startsWith("AAA"))).toBe(
      true
    );
    const supps = getSupplements(a.profileId);
    expect(supps.length).toBe(2);
    expect(supps.every((s) => s.name.startsWith("AAA"))).toBe(true);
    expect(supps.some((s) => s.name.startsWith("BBB"))).toBe(false);
  });

  it("getMedicalRecords never surfaces the other profile's readings", () => {
    const recsA = getMedicalRecords(a.profileId);
    expect(recsA.length).toBe(1);
    expect(recsA[0].value_num).toBe(90); // A's glucose, not B's 200
    const recsB = getMedicalRecords(b.profileId);
    expect(recsB[0].value_num).toBe(200);
  });

  it("immunization dose + override reads are per-profile", () => {
    // B carries the same vaccine code + override; A's reads must not pick them up.
    expect(getImmunizations(a.profileId).length).toBe(1);
    const ovrA = getImmunizationOverrides(a.profileId);
    expect(ovrA.length).toBe(1);
    expect(ovrA[0].vaccine).toBe(a.declinedVaccine);
  });
});
