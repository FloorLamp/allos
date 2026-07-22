import { describe, expect, it } from "vitest";
import {
  buildFitnessCheckModel,
  type AssessmentLike,
  type AmbientReading,
} from "@/lib/fitness-check-model";
import { batteryForAge } from "@/lib/fitness-battery";

// Pure view-model derivation (issue #834): completion %, per-domain percentile bars, and
// direction-aware check-over-check deltas — plus the #1129 ambient auto-count/provenance/
// stale resolution and the #1135 self-norm rough band. No DB.

const adultBattery = batteryForAge(40);
const NO_AMBIENT: AmbientReading[] = [];

// Convenience: build over a newest-first sessions list with no ambient readings.
function model(
  sessions: AssessmentLike[],
  sex: "male" | "female" | null,
  age: number | null,
  bw: number | null,
  ambient: AmbientReading[] = NO_AMBIENT,
  today: string | null = null,
  cadence = 180
) {
  return buildFitnessCheckModel(
    adultBattery,
    sessions,
    ambient,
    sex,
    age,
    bw,
    today,
    cadence
  );
}

describe("completion coverage", () => {
  it("counts measured tests against the battery size (partial sessions first-class)", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [
        { testKey: "vo2max", value: 45 },
        { testKey: "grip", value: 48 },
      ],
    };
    const m = model([latest], "male", 40, 80);
    expect(m.measuredCount).toBe(2);
    expect(m.totalCount).toBe(adultBattery.length);
    expect(m.results.find((r) => r.key === "vo2max")!.measured).toBe(true);
    expect(m.results.find((r) => r.key === "plank")!.measured).toBe(false);
  });

  it("reports zero coverage for an empty/absent session", () => {
    const m = model([], "male", 40, 80);
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
    const m = model([latest], "male", 25, 80);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.percentile!.percentile).toBe(50);
    expect(vo2.favorability).toBe(50);
    const endurance = m.domains.find((d) => d.domain === "endurance")!;
    expect(endurance.percentile).toBe(50);
    expect(endurance.measuredCount).toBeGreaterThanOrEqual(1);
  });

  it("hides percentiles for a minor (adult-gated norms) but still records coverage", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "vo2max", value: 45 }],
    };
    const m = model([latest], "male", 15, 60);
    expect(m.results.find((r) => r.key === "vo2max")!.percentile).toBeNull();
    expect(m.measuredCount).toBe(1); // coverage still counts
  });

  it("carries a fitness-age headline from the VO2 test", () => {
    const latest: AssessmentLike = {
      date: "2026-03-01",
      entries: [{ testKey: "vo2max", value: 43.9 }],
    };
    const m = model([latest], "male", 25, 80);
    expect(m.headlineFitnessAge).not.toBeNull();
  });
});

describe("check-over-check deltas (direction-aware)", () => {
  it("marks a higher grip as an improvement", () => {
    const sessions: AssessmentLike[] = [
      { date: "2026-03-01", entries: [{ testKey: "grip", value: 48 }] },
      { date: "2026-01-01", entries: [{ testKey: "grip", value: 44 }] },
    ];
    const m = model(sessions, "male", 45, 80);
    const grip = m.results.find((r) => r.key === "grip")!;
    expect(grip.delta).toBe(4);
    expect(grip.improved).toBe(true);
  });

  it("marks a LOWER resting HR as an improvement (lowerIsBetter)", () => {
    const sessions: AssessmentLike[] = [
      { date: "2026-03-01", entries: [{ testKey: "restinghr", value: 58 }] },
      { date: "2026-01-01", entries: [{ testKey: "restinghr", value: 62 }] },
    ];
    const m = model(sessions, "male", 45, 80);
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
    const m = model([latest], "male", 45, 80);
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
    const m = model([latest], "male", 30, 80);
    const big = m.results.find((r) => r.key === "biglift")!;
    expect(big.standingLift).toBe("Back Squat");
    expect(big.standing).not.toBeNull();
    expect(big.standing!.label).toBeTruthy();
    // Favorability is a 0–100 ladder position (reusing strengthStanding, no second ladder).
    expect(big.favorability).not.toBeNull();
    expect(big.favorability!).toBeGreaterThan(0);
    expect(big.favorability!).toBeLessThanOrEqual(100);
  });
});

describe("#1129 ambient auto-count + provenance + stale", () => {
  it("auto-counts a synced natural-store reading as measured with a synced provenance", () => {
    const ambient: AmbientReading[] = [
      { testKey: "vo2max", value: 48, date: "2026-06-28", source: "oura" },
    ];
    const m = model([], "male", 40, 80, ambient, "2026-07-01", 180);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.measured).toBe(true);
    expect(vo2.value).toBe(48);
    expect(vo2.percentile).not.toBeNull(); // percentiles reflect ambient data
    expect(vo2.provenance!.kind).toBe("synced");
    expect(vo2.provenance!.sourceName).toBe("Oura");
    expect(vo2.provenance!.stale).toBe(false);
    expect(m.measuredCount).toBe(1);
  });

  it("marks an out-of-cadence-window stored value STALE (measured, but re-check)", () => {
    const ambient: AmbientReading[] = [
      { testKey: "bodyfat", value: 18, date: "2025-01-01", source: "withings" },
    ];
    const m = model([], "male", 40, 80, ambient, "2026-07-01", 180);
    const bf = m.results.find((r) => r.key === "bodyfat")!;
    expect(bf.measured).toBe(true);
    expect(bf.provenance!.stale).toBe(true);
    expect(bf.provenance!.ageDays).toBeGreaterThan(180);
  });

  it("a fresh check entry overrides an older ambient value (newest wins), tagged 'check'", () => {
    const ambient: AmbientReading[] = [
      { testKey: "grip", value: 40, date: "2026-05-01", source: "manual" },
    ];
    const sessions: AssessmentLike[] = [
      { date: "2026-06-30", entries: [{ testKey: "grip", value: 50 }] },
    ];
    const m = model(sessions, "male", 40, 80, ambient, "2026-07-01", 180);
    const grip = m.results.find((r) => r.key === "grip")!;
    expect(grip.value).toBe(50); // the newer check wins
    expect(grip.provenance!.kind).toBe("check");
  });

  it("compares an ambient value NEWER than the last check honestly against that check", () => {
    const ambient: AmbientReading[] = [
      { testKey: "vo2max", value: 50, date: "2026-06-30", source: "oura" },
    ];
    const sessions: AssessmentLike[] = [
      { date: "2026-01-01", entries: [{ testKey: "vo2max", value: 46 }] },
    ];
    const m = model(sessions, "male", 40, 80, ambient, "2026-07-01", 180);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.value).toBe(50);
    expect(vo2.provenance!.kind).toBe("synced");
    expect(vo2.delta).toBe(4); // 50 vs the prior check's 46
    expect(vo2.improved).toBe(true);
  });

  it("collapses a same-date check + ambient twin to ONE measurement (no double count)", () => {
    const ambient: AmbientReading[] = [
      { testKey: "grip", value: 50, date: "2026-06-30", source: "manual" },
    ];
    const sessions: AssessmentLike[] = [
      { date: "2026-06-30", entries: [{ testKey: "grip", value: 50 }] },
    ];
    const m = model(sessions, "male", 40, 80, ambient, "2026-07-01", 180);
    const grip = m.results.find((r) => r.key === "grip")!;
    expect(grip.value).toBe(50);
    expect(grip.provenance!.kind).toBe("check"); // tie → check
    expect(grip.delta).toBeNull(); // no prior distinct check
  });
});

describe("#1135 self-norm (dead hang / plank)", () => {
  it("yields a rough band + retains the personal delta, never a percentile", () => {
    const sessions: AssessmentLike[] = [
      { date: "2026-03-01", entries: [{ testKey: "plank", value: 90 }] },
      { date: "2026-01-01", entries: [{ testKey: "plank", value: 60 }] },
    ];
    const m = model(sessions, "male", 40, 80);
    const plank = m.results.find((r) => r.key === "plank")!;
    expect(plank.tier).toBe("self-norm");
    expect(plank.percentile).toBeNull(); // NEVER a percentile
    expect(plank.selfNorm!.band).toBe("good"); // 90s male → good
    expect(plank.selfNorm!.quality).toBe("rough");
    expect(plank.favorability).toBe(plank.selfNorm!.position);
    expect(plank.delta).toBe(30);
    expect(plank.improved).toBe(true);
  });

  it("does NOT contribute to the fitness-age headline or a domain percentile", () => {
    const sessions: AssessmentLike[] = [
      { date: "2026-03-01", entries: [{ testKey: "deadhang", value: 120 }] },
    ];
    const m = model(sessions, "male", 40, 80);
    // strength domain has no norms measured → its percentile stays null despite the
    // self-norm band being favorable.
    const strength = m.domains.find((d) => d.domain === "strength")!;
    expect(strength.percentile).toBeNull();
    expect(m.headlineFitnessAge).toBeNull();
  });
});

describe("senior battery variant", () => {
  it("builds the senior tests (arm curl, TUG, 4-stage) for an older subject", () => {
    const senior = batteryForAge(72);
    const m = buildFitnessCheckModel(
      senior,
      [{ date: "2026-03-01", entries: [{ testKey: "tug", value: 5.2 }] }],
      [],
      "male",
      72,
      75
    );
    const tug = m.results.find((r) => r.key === "tug")!;
    expect(tug.measured).toBe(true);
    expect(tug.lowerIsBetter).toBe(true);
    expect(tug.percentile).not.toBeNull(); // TUG has senior norms
    expect(m.results.find((r) => r.key === "pushups")).toBeUndefined(); // not in senior battery
  });
});
