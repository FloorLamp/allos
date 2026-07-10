import { describe, it, expect } from "vitest";
import {
  buildPillars,
  optimalRangeHitRate,
  type BiomarkerReading,
} from "@/lib/healthspan-pillars";
import { formatPercentile, type FitnessPercentile } from "@/lib/fitness-norms";
import { bioAgeDelta, bioAgeDeltaPhrase } from "@/lib/bio-age";
import { strengthLevelLabel } from "@/lib/strength-standards";
import type { CanonicalBiomarker } from "@/lib/types";

// A minimal canonical row carrying just the fields rangeBadge reads (name/unit for
// conversion, ref + optimal bands, direction). Cast through unknown so the fixture
// stays small.
function cb(
  partial: Partial<CanonicalBiomarker> & {
    name: string;
    unit: string;
    direction: CanonicalBiomarker["direction"];
  }
): CanonicalBiomarker {
  return partial as unknown as CanonicalBiomarker;
}

const totalChol = cb({
  name: "Total Cholesterol",
  unit: "mg/dL",
  direction: "lower_better",
  ref_low: 125,
  ref_high: 200,
  optimal_low: null,
  optimal_high: 180,
});

describe("optimalRangeHitRate", () => {
  it("counts markers whose latest reading sits in the optimal band", () => {
    const readings: BiomarkerReading[] = [
      { value_num: 170, unit: "mg/dL", cb: totalChol }, // optimal (≤180)
      { value_num: 175, unit: "mg/dL", cb: totalChol }, // optimal
      { value_num: 195, unit: "mg/dL", cb: totalChol }, // above optimal (still in ref)
    ];
    expect(optimalRangeHitRate(readings)).toEqual({ optimal: 2, total: 3 });
  });

  it("excludes markers we can't judge (no canonical row, or unconvertible)", () => {
    const readings: BiomarkerReading[] = [
      { value_num: 170, unit: "mg/dL", cb: totalChol }, // judged, optimal
      { value_num: 5, unit: "mg/dL", cb: null }, // no canonical → excluded
      { value_num: null, unit: "mg/dL", cb: totalChol }, // no value → excluded
    ];
    expect(optimalRangeHitRate(readings)).toEqual({ optimal: 1, total: 1 });
  });

  it("empty input yields a zero denominator (pillar hides)", () => {
    expect(optimalRangeHitRate([])).toEqual({ optimal: 0, total: 0 });
  });
});

describe("buildPillars availability", () => {
  it("renders nothing when no inputs are present", () => {
    expect(buildPillars({})).toEqual([]);
  });

  it("omits the optimal pillar when the denominator is zero", () => {
    const pillars = buildPillars({ optimal: { optimal: 0, total: 0 } });
    expect(pillars).toEqual([]);
  });

  it("renders only the pillars whose data exists", () => {
    const pillars = buildPillars({
      sleep: { sri: 84 },
      optimal: { optimal: 31, total: 38 },
    });
    expect(pillars.map((p) => p.key)).toEqual([
      "sleep-regularity",
      "optimal-biomarkers",
    ]);
  });

  it("includes the strength pillar when a standing is present", () => {
    const pillars = buildPillars({
      strength: { level: "advanced", lift: "Back Squat" },
    });
    expect(pillars.map((p) => p.key)).toEqual(["strength"]);
    expect(pillars[0].detail).toContain("Back Squat");
  });
});

describe("buildPillars value equals its source computation (#224)", () => {
  it("VO2 pillar value is formatPercentile of the source percentile", () => {
    const percentile: FitnessPercentile = { percentile: 62, clamped: null };
    const [pillar] = buildPillars({ vo2: { percentile, fitnessAge: null } });
    expect(pillar.value).toBe(formatPercentile(percentile));
    expect(pillar.tone).toBe("good"); // ≥50th
  });

  it("bio-age pillar value is bioAgeDeltaPhrase of the source delta", () => {
    const delta = bioAgeDelta(45, 50);
    const [pillar] = buildPillars({ bioAge: { delta } });
    expect(pillar.value).toBe(bioAgeDeltaPhrase(delta));
    expect(pillar.tone).toBe("good"); // biologically younger
  });

  it("optimal pillar value is the raw N-of-M hit rate", () => {
    const [pillar] = buildPillars({ optimal: { optimal: 31, total: 38 } });
    expect(pillar.value).toBe("31 of 38");
    expect(pillar.tone).toBe("good"); // 31/38 ≥ 0.8
  });

  it("sleep pillar value is the rounded SRI", () => {
    const [pillar] = buildPillars({ sleep: { sri: 83.6 } });
    expect(pillar.value).toBe("SRI 84");
    expect(pillar.tone).toBe("good"); // ≥80
  });

  it("strength pillar value is the label of the source level", () => {
    const [pillar] = buildPillars({
      strength: { level: "intermediate", lift: "Deadlift" },
    });
    expect(pillar.value).toBe(strengthLevelLabel("intermediate"));
    expect(pillar.tone).toBe("warn"); // intermediate
  });
});
