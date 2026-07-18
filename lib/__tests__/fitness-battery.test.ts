import { describe, expect, it } from "vitest";
import {
  FITNESS_BATTERY,
  batteryForAge,
  usesSeniorBattery,
  computeVo2,
  VO2_METHODS,
  fitnessTest,
  SENIOR_BATTERY_MIN_AGE,
} from "@/lib/fitness-battery";
import { FITNESS_NORM_MARKERS, hasFitnessNorms } from "@/lib/fitness-norms";
import { STRENGTH_STANDARD_LIFTS } from "@/lib/strength-standards";
import { liftInfo } from "@/lib/lifts";

// The battery dataset must stay consistent with the scoring engines: every norms-tier
// test names a real fitness-norms marker; every standard-tier test resolves against
// strength-standards; the self-trend tier carries NO percentile path; and every set-
// stored test names a real catalog lift. Pure — no DB.

describe("battery ↔ scoring-engine consistency", () => {
  it("every norms-tier test names a marker the fitness-norms engine resolves", () => {
    for (const t of FITNESS_BATTERY) {
      if (t.tier !== "norms") continue;
      expect(
        t.normsMarker,
        `${t.key} is norms tier but has no marker`
      ).toBeTruthy();
      expect(
        FITNESS_NORM_MARKERS,
        `${t.key} marker "${t.normsMarker}" not in fitness-norms`
      ).toContain(t.normsMarker!);
      expect(hasFitnessNorms(t.normsMarker!)).toBe(true);
    }
  });

  it("the standard tier resolves against strength-standards (one big-lift e1RM)", () => {
    const standard = FITNESS_BATTERY.filter((t) => t.tier === "standard");
    expect(standard.length).toBeGreaterThan(0);
    // The strength standard is over a user-chosen lift; the core squat/bench/deadlift/
    // press all carry standards. Assert at least the core lifts are covered.
    for (const lift of [
      "Back Squat",
      "Bench Press",
      "Deadlift",
      "Overhead Press",
    ]) {
      expect(STRENGTH_STANDARD_LIFTS).toContain(lift);
    }
  });

  it("the self-trend tier carries NO percentile path (no norms marker, not norms tier)", () => {
    const selfTrend = FITNESS_BATTERY.filter((t) => t.tier === "self-trend");
    expect(selfTrend.length).toBeGreaterThan(0);
    for (const t of selfTrend) {
      expect(
        t.normsMarker,
        `${t.key} self-trend must not carry a norms marker`
      ).toBeUndefined();
    }
  });

  it("no non-norms tier smuggles a norms marker", () => {
    for (const t of FITNESS_BATTERY) {
      if (t.tier === "norms") continue;
      expect(
        t.normsMarker,
        `${t.key} (${t.tier}) must not carry a norms marker`
      ).toBeUndefined();
    }
  });

  it("every set-stored test names a real catalog lift", () => {
    for (const t of FITNESS_BATTERY) {
      if (t.store.kind !== "set") continue;
      if (t.store.lift === "") continue; // big-lift: chosen at entry time
      expect(
        liftInfo(t.store.lift),
        `${t.key} lift "${t.store.lift}"`
      ).toBeTruthy();
    }
  });

  it("has unique test keys", () => {
    const keys = FITNESS_BATTERY.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("age-banded battery swap (adult ↔ senior)", () => {
  it("gives adults the push-up/dead-hang items, not the senior SFT items", () => {
    const adult = batteryForAge(40).map((t) => t.key);
    expect(adult).toContain("pushups");
    expect(adult).toContain("deadhang");
    expect(adult).not.toContain("armcurl");
    expect(adult).not.toContain("tug");
    expect(adult).not.toContain("fourstage");
  });

  it("swaps to the senior variant at the age threshold (never a Cooper run / dead hang)", () => {
    const senior = batteryForAge(70).map((t) => t.key);
    expect(senior).toContain("armcurl");
    expect(senior).toContain("tug");
    expect(senior).toContain("fourstage");
    expect(senior).toContain("vo2step2min");
    expect(senior).not.toContain("pushups");
    expect(senior).not.toContain("deadhang");
    expect(senior).not.toContain("plank");
  });

  it("keeps the shared 'both' tests in both variants", () => {
    for (const age of [40, 70]) {
      const keys = batteryForAge(age).map((t) => t.key);
      for (const shared of [
        "vo2max",
        "grip",
        "chairstand",
        "balance",
        "bodyfat",
        "srt",
      ]) {
        expect(keys, `age ${age} missing ${shared}`).toContain(shared);
      }
    }
  });

  it("banded exactly at SENIOR_BATTERY_MIN_AGE", () => {
    expect(usesSeniorBattery(SENIOR_BATTERY_MIN_AGE)).toBe(true);
    expect(usesSeniorBattery(SENIOR_BATTERY_MIN_AGE - 1)).toBe(false);
    expect(usesSeniorBattery(null)).toBe(false); // unknown → adult default
  });

  it("excludes the maximal Cooper run from the senior VO2 field-test methods", () => {
    const cooper = VO2_METHODS.find((m) => m.key === "cooper")!;
    expect(cooper.seniorSafe).toBe(false);
    // The step and walk tests stay available for seniors.
    expect(VO2_METHODS.find((m) => m.key === "step")!.seniorSafe).toBe(true);
    expect(VO2_METHODS.find((m) => m.key === "rockport")!.seniorSafe).toBe(
      true
    );
  });
});

describe("VO2 method dispatch", () => {
  it("passes a watch value through verbatim (rounded)", () => {
    expect(computeVo2("watch", { watchValue: 44.2 }, "male", 40)!.vo2).toBe(
      44.2
    );
    expect(computeVo2("watch", { watchValue: null }, "male", 40)).toBeNull();
  });

  it("routes cooper/rockport/step to the cited calculators", () => {
    expect(
      computeVo2("cooper", { distanceMeters: 2400 }, "male", 40)!.method
    ).toMatch(/Cooper/);
    expect(
      computeVo2(
        "rockport",
        { weightLb: 175, walkTimeMin: 14, walkHr: 140 },
        "male",
        40
      )!.method
    ).toMatch(/Rockport/);
    expect(
      computeVo2("step", { stepRecoveryHr: 150 }, "female", 70)!.method
    ).toMatch(/Queens/);
  });

  it("returns null when the chosen method's inputs are missing", () => {
    expect(computeVo2("cooper", {}, "male", 40)).toBeNull();
    expect(computeVo2("step", { stepRecoveryHr: null }, "male", 40)).toBeNull();
  });
});

describe("fitnessTest lookup", () => {
  it("resolves a known key and refuses an unknown one", () => {
    expect(fitnessTest("vo2max")!.label).toBe("VO2 Max");
    expect(fitnessTest("nope")).toBeUndefined();
  });
});
