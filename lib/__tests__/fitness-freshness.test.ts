import { describe, expect, it } from "vitest";
import {
  DEFAULT_FITNESS_FRESHNESS,
  FITNESS_FLOOR_QUANTITIES,
  FITNESS_FRESHNESS,
  fitnessFloorsNotShared,
  fitnessFreshnessDays,
  fitnessFreshnessPolicy,
  missingFreshnessPolicies,
} from "@/lib/fitness-freshness";
import { TREND_METRIC_PRESENTATION_FLOORS } from "@/lib/trend-metric-freshness";
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

  it("every exception to the profile cadence states why it exists", () => {
    for (const policy of Object.values(FITNESS_FRESHNESS)) {
      if (policy.kind === "profile-cadence") continue;
      if (policy.kind === "fixed-days") expect(policy.days).toBeGreaterThan(0);
      expect(policy.because.length).toBeGreaterThan(20);
    }
  });

  // #4242 — the second completeness census, reading the way the one above does.
  it("no shared quantity declares a second freshness number of its own", () => {
    expect(fitnessFloorsNotShared()).toEqual([]);
  });

  it("catches a shared quantity that restates a number instead of referencing", () => {
    expect(
      fitnessFloorsNotShared({
        ...FITNESS_FRESHNESS,
        restinghr: { kind: "fixed-days", days: 30, because: "a second answer" },
      })
    ).toEqual(["restinghr"]);
  });
});

describe("policy resolution", () => {
  it("a performed protocol inherits the profile's retest cadence", () => {
    expect(fitnessFreshnessPolicy("vo2max")).toEqual(DEFAULT_FITNESS_FRESHNESS);
    expect(fitnessFreshnessDays("vo2max", 180)).toBe(180);
    expect(fitnessFreshnessDays("vo2max", 90)).toBe(90);
  });

  // #4242 — the floor is the QUANTITY'S, read through the trend-metric registry, so the
  // expectation names the shared entry rather than repeating a number that could drift.
  it("a shared quantity takes its own surfaces' presentation floor", () => {
    for (const [key, slug] of Object.entries(FITNESS_FLOOR_QUANTITIES))
      for (const cadence of [90, 180, 365])
        expect(fitnessFreshnessDays(key, cadence)).toBe(
          TREND_METRIC_PRESENTATION_FLOORS[slug].days
        );
    // The reconciled values as they stand, so a deliberate move to either floor is a
    // visible edit here rather than a silent one (was 30 / 60 before #4242).
    expect(fitnessFreshnessDays("restinghr", 180)).toBe(14);
    expect(fitnessFreshnessDays("bodyfat", 180)).toBe(45);
  });

  it("an unknown key falls back to the documented default rather than throwing", () => {
    expect(fitnessFreshnessDays("not-a-test", 120)).toBe(120);
  });
});

describe("per-test freshness in the check model", () => {
  it("one cadence no longer decides every test: same date, different verdicts", () => {
    // 100 days ago: inside the 180-day protocol cadence, past the 14/45-day body floors.
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
    expect(by.get("restinghr")!.provenance!.freshnessDays).toBe(14);
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
    expect(strength.bestPercentile!).toBeGreaterThan(
      strength.lowestPercentile!
    );
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
