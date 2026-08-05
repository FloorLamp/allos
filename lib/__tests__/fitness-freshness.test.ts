import { describe, expect, it } from "vitest";
import {
  DEFAULT_FITNESS_FRESHNESS,
  FITNESS_FRESHNESS,
  fitnessFreshnessDays,
  fitnessFreshnessPolicy,
  missingFreshnessPolicies,
} from "@/lib/fitness-freshness";
import {
  buildFitnessCheckModel,
  type AmbientReading,
  type AssessmentLike,
} from "@/lib/fitness-check-model";
import { batteryForAge, FITNESS_BATTERY } from "@/lib/fitness-battery";

// #2025 — every battery test declares how its freshness is resolved, and the check model
// separates fresh / stale / unmeasured instead of calling any stored value "recent".

const TODAY = "2026-08-05";
const adultBattery = batteryForAge(40);
const NO_AMBIENT: AmbientReading[] = [];

function model(
  sessions: AssessmentLike[],
  ambient: AmbientReading[] = NO_AMBIENT,
  cadence = 180
) {
  return buildFitnessCheckModel(
    adultBattery,
    sessions,
    ambient,
    "male",
    40,
    80,
    TODAY,
    cadence
  );
}

describe("the freshness registry is complete (#2025)", () => {
  it("every battery test declares a policy — a new test without one fails here", () => {
    expect(missingFreshnessPolicies(FITNESS_BATTERY)).toEqual([]);
  });

  it("covers both age variants of the battery", () => {
    expect(missingFreshnessPolicies(batteryForAge(40))).toEqual([]);
    expect(missingFreshnessPolicies(batteryForAge(72))).toEqual([]);
  });

  it("declares no policy for a key that is not a battery test", () => {
    const batteryKeys = new Set(FITNESS_BATTERY.map((t) => t.key));
    for (const key of Object.keys(FITNESS_FRESHNESS))
      expect(batteryKeys.has(key)).toBe(true);
  });

  it("every fixed-days exception states why it exists", () => {
    for (const policy of Object.values(FITNESS_FRESHNESS)) {
      if (policy.kind !== "fixed-days") continue;
      expect(policy.days).toBeGreaterThan(0);
      expect(policy.because.length).toBeGreaterThan(20);
    }
  });
});

describe("policy resolution", () => {
  it("a performed protocol inherits the profile's retest cadence", () => {
    expect(fitnessFreshnessPolicy("vo2max")).toEqual(DEFAULT_FITNESS_FRESHNESS);
    expect(fitnessFreshnessDays("vo2max", 180)).toBe(180);
    expect(fitnessFreshnessDays("vo2max", 90)).toBe(90);
  });

  it("a continuously measurable value keeps its own shorter clock", () => {
    expect(fitnessFreshnessDays("restinghr", 180)).toBe(30);
    expect(fitnessFreshnessDays("bodyfat", 180)).toBe(60);
    // …and does not lengthen when the profile picks a long cadence.
    expect(fitnessFreshnessDays("restinghr", 365)).toBe(30);
  });

  it("an unknown key falls back to the documented default rather than throwing", () => {
    expect(fitnessFreshnessDays("not-a-test", 120)).toBe(120);
  });
});

describe("per-test freshness in the check model", () => {
  it("one cadence no longer decides every test: same date, different verdicts", () => {
    // 100 days ago: inside the 180-day protocol cadence, past the 30/60-day body clocks.
    const sessions: AssessmentLike[] = [
      {
        date: "2026-04-27",
        entries: [
          { testKey: "vo2max", value: 45 },
          { testKey: "restinghr", value: 58 },
          { testKey: "bodyfat", value: 18 },
        ],
      },
    ];
    const m = model(sessions);
    const by = new Map(m.results.map((r) => [r.key, r]));
    expect(by.get("vo2max")!.freshness).toBe("current");
    expect(by.get("restinghr")!.freshness).toBe("due");
    expect(by.get("bodyfat")!.freshness).toBe("due");
    // The interval that applied is disclosed on the provenance.
    expect(by.get("vo2max")!.provenance!.freshnessDays).toBe(180);
    expect(by.get("restinghr")!.provenance!.freshnessDays).toBe(30);
  });

  it("stale results stay measured and keep their provenance", () => {
    const m = model([
      { date: "2020-01-01", entries: [{ testKey: "vo2max", value: 45 }] },
    ]);
    const vo2 = m.results.find((r) => r.key === "vo2max")!;
    expect(vo2.measured).toBe(true);
    expect(vo2.value).toBe(45);
    expect(vo2.provenance!.date).toBe("2020-01-01");
    expect(vo2.provenance!.stale).toBe(true);
    expect(vo2.freshness).toBe("due");
  });

  it("an unmeasured test is not stale", () => {
    const m = model([]);
    for (const r of m.results) expect(r.freshness).toBe("not-applicable");
    expect(m.coverage.stale).toBe(0);
  });
});

describe("whole-check coverage separates fresh, stale and unmeasured", () => {
  it("a stale-only check has historical coverage but no current coverage", () => {
    const m = model([
      {
        date: "2020-01-01",
        entries: [
          { testKey: "vo2max", value: 45 },
          { testKey: "grip", value: 48 },
        ],
      },
    ]);
    expect(m.measuredCount).toBe(2); // "has any value" is unchanged
    expect(m.coverage.measured).toBe(2);
    expect(m.coverage.fresh).toBe(0); // …and cannot satisfy "current"
    expect(m.coverage.stale).toBe(2);
    expect(m.coverage.unmeasured).toBe(m.coverage.total - 2);
  });

  it("mixed freshness splits cleanly and the parts sum to the whole", () => {
    const m = model([
      { date: "2026-08-01", entries: [{ testKey: "vo2max", value: 45 }] },
      { date: "2020-01-01", entries: [{ testKey: "grip", value: 48 }] },
    ]);
    expect(m.coverage.fresh).toBe(1);
    expect(m.coverage.stale).toBe(1);
    expect(m.coverage.measured).toBe(m.coverage.fresh + m.coverage.stale);
    expect(m.coverage.measured + m.coverage.unmeasured).toBe(m.coverage.total);
  });

  it("domain coverage sums to the whole-check coverage", () => {
    const m = model([
      {
        date: "2026-08-01",
        entries: [
          { testKey: "vo2max", value: 45 },
          { testKey: "grip", value: 48 },
        ],
      },
      { date: "2020-01-01", entries: [{ testKey: "sitreach", value: 20 }] },
    ]);
    const sum = (pick: (c: (typeof m.domains)[number]["coverage"]) => number) =>
      m.domains.reduce((n, d) => n + pick(d.coverage), 0);
    expect(sum((c) => c.total)).toBe(m.coverage.total);
    expect(sum((c) => c.fresh)).toBe(m.coverage.fresh);
    expect(sum((c) => c.stale)).toBe(m.coverage.stale);
    expect(sum((c) => c.unmeasured)).toBe(m.coverage.unmeasured);
  });
});

describe("the domain rollup names the best norms result (#2025)", () => {
  it("divergent norms results are carried as a range, not one number", () => {
    // Strength: an excellent grip and a weak push-up count, both norms-backed.
    const m = model([
      {
        date: "2026-08-01",
        entries: [
          { testKey: "grip", value: 65 },
          { testKey: "pushups", value: 5 },
        ],
      },
    ]);
    const strength = m.domains.find((d) => d.domain === "strength")!;
    expect(strength.normsCount).toBe(2);
    expect(strength.bestPercentile).not.toBeNull();
    expect(strength.lowestPercentile).not.toBeNull();
    expect(strength.bestPercentile!).toBeGreaterThan(strength.lowestPercentile!);
    // The bar is the BEST result — the model never claims it is the domain.
    expect(strength.bestPercentile).toBe(
      Math.max(
        ...m.results
          .filter((r) => r.domain === "strength")
          .map((r) => r.percentile?.percentile ?? -1)
      )
    );
  });

  it("a single norms result has best === lowest and a count of one", () => {
    const m = model([
      { date: "2026-08-01", entries: [{ testKey: "vo2max", value: 45 }] },
    ]);
    const endurance = m.domains.find((d) => d.domain === "endurance")!;
    expect(endurance.normsCount).toBe(1);
    expect(endurance.bestPercentile).toBe(endurance.lowestPercentile);
  });

  it("a non-norms tier never enters the percentile rollup", () => {
    const m = model([
      { date: "2026-08-01", entries: [{ testKey: "deadhang", value: 120 }] },
    ]);
    const strength = m.domains.find((d) => d.domain === "strength")!;
    expect(strength.normsCount).toBe(0);
    expect(strength.bestPercentile).toBeNull();
    expect(strength.lowestPercentile).toBeNull();
    // …but the self-norm result still counts as coverage.
    expect(strength.coverage.measured).toBe(1);
  });

  it("a stale norms result still backs the best-of number, and is disclosed", () => {
    const m = model([
      { date: "2020-01-01", entries: [{ testKey: "vo2max", value: 45 }] },
    ]);
    const endurance = m.domains.find((d) => d.domain === "endurance")!;
    expect(endurance.bestPercentile).not.toBeNull();
    expect(endurance.coverage.stale).toBe(1);
    expect(endurance.coverage.fresh).toBe(0);
  });
});
