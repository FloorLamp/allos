import { describe, expect, it } from "vitest";
import {
  buildFitnessCheckModel,
  type AssessmentLike,
} from "@/lib/fitness-check-model";
import { batteryForAge } from "@/lib/fitness-battery";

// Pure view-model derivation (issue #834): completion %, per-domain percentile bars, and
// direction-aware check-over-check deltas. No DB.

const adultBattery = batteryForAge(40);

describe("completion coverage", () => {
  it("counts measured tests against the battery size (partial sessions first-class)", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [
        { testKey: "vo2max", value: 45 },
        { testKey: "grip", value: 48 },
      ],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      40,
      80
    );
    expect(m.measuredCount).toBe(2);
    expect(m.totalCount).toBe(adultBattery.length);
    expect(m.results.find((r) => r.key === "vo2max")!.measured).toBe(true);
    expect(m.results.find((r) => r.key === "plank")!.measured).toBe(false);
  });

  it("reports zero coverage for an empty/absent session", () => {
    const m = buildFitnessCheckModel(adultBattery, null, null, "male", 40, 80);
    expect(m.measuredCount).toBe(0);
    expect(m.results.every((r) => !r.measured)).toBe(true);
  });
});

describe("norms percentiles + domain bars", () => {
  it("scores a norms test and rolls the best percentile into its domain", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "vo2max", value: 43.9 }], // male age 25 p50
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      25,
      80
    );
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.percentile!.percentile).toBe(50);
    const endurance = m.domains.find((d) => d.domain === "endurance")!;
    expect(endurance.percentile).toBe(50);
    expect(endurance.measuredCount).toBeGreaterThanOrEqual(1);
  });

  it("hides percentiles for a minor (adult-gated norms) but still records coverage", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "vo2max", value: 45 }],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      15,
      60
    );
    expect(m.results.find((r) => r.key === "vo2max")!.percentile).toBeNull();
    expect(m.measuredCount).toBe(1); // coverage still counts
  });

  it("carries a fitness-age headline from the VO2 test", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "vo2max", value: 43.9 }],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      25,
      80
    );
    expect(m.headlineFitnessAge).not.toBeNull();
  });
});

describe("check-over-check deltas (direction-aware)", () => {
  it("marks a higher grip as an improvement", () => {
    const prior: AssessmentLike = {
      date: "2026-01-01",
      entries: [{ testKey: "grip", value: 44 }],
    };
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "grip", value: 48 }],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      prior,
      "male",
      45,
      80
    );
    const grip = m.results.find((r) => r.key === "grip")!;
    expect(grip.delta).toBe(4);
    expect(grip.improved).toBe(true);
  });

  it("marks a LOWER resting HR as an improvement (lowerIsBetter)", () => {
    const prior: AssessmentLike = {
      date: "2026-01-01",
      entries: [{ testKey: "restinghr", value: 62 }],
    };
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "restinghr", value: 58 }],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      prior,
      "male",
      45,
      80
    );
    const hr = m.results.find((r) => r.key === "restinghr")!;
    expect(hr.delta).toBe(-4);
    expect(hr.improved).toBe(true);
    expect(hr.lowerIsBetter).toBe(true);
  });

  it("leaves delta null when there's no prior measurement", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "grip", value: 48 }],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      45,
      80
    );
    expect(m.results.find((r) => r.key === "grip")!.delta).toBeNull();
  });
});

describe("standard-tier big lift", () => {
  it("places the e1RM against strength standards using the chosen lift + bodyweight", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [
        {
          testKey: "biglift",
          value: 140,
          rawInput: { lift: "Back Squat", weightKg: 120, reps: 3 },
        },
      ],
    };
    const m = buildFitnessCheckModel(
      adultBattery,
      latest,
      null,
      "male",
      30,
      80
    );
    const big = m.results.find((r) => r.key === "biglift")!;
    expect(big.standingLift).toBe("Back Squat");
    expect(big.standing).not.toBeNull();
    expect(big.standing!.label).toBeTruthy();
  });
});

describe("senior battery variant", () => {
  it("builds the senior tests (arm curl, TUG, 4-stage) for an older subject", () => {
    const senior = batteryForAge(72);
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "tug", value: 5.2 }],
    };
    const m = buildFitnessCheckModel(senior, latest, null, "male", 72, 75);
    const tug = m.results.find((r) => r.key === "tug")!;
    expect(tug.measured).toBe(true);
    expect(tug.lowerIsBetter).toBe(true);
    expect(tug.percentile).not.toBeNull(); // TUG has senior norms
    expect(m.results.find((r) => r.key === "pushups")).toBeUndefined(); // not in senior battery
  });
});
