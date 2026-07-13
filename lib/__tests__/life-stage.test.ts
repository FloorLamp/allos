import { describe, it, expect } from "vitest";
import {
  lifeStage,
  isAdultForClinical,
  isMinor,
  isAdultBpRegime,
  isGrowthTracked,
  isFoodLoggingRelevant,
  INFANT_MAX_AGE,
  PEDIATRIC_BP_MAX_AGE,
  ADULT_MIN_AGE,
  GROWTH_CHART_MAX_AGE,
  OLDER_ADULT_MIN_AGE,
} from "@/lib/life-stage";
import { ADULT_MIN_AGE as FITNESS_ADULT_MIN_AGE } from "@/lib/fitness-norms";
import { ADULT_BP_AGE, pediatricBpContext } from "@/lib/bp-percentiles";
import { PHENOAGE_MIN_AGE } from "@/lib/derived-biomarkers";
import { GROWTH_CHART_MAX_AGE as GROWTH_METRICS_CEILING } from "@/lib/growth-metrics";
import { MAX_AGE_MONTHS } from "@/lib/growth";

describe("lifeStage classifier", () => {
  it("maps ages onto the five named stages", () => {
    expect(lifeStage(0)).toBe("infant");
    expect(lifeStage(0.5)).toBe("infant");
    expect(lifeStage(1)).toBe("child");
    expect(lifeStage(12)).toBe("child");
    expect(lifeStage(13)).toBe("adolescent");
    expect(lifeStage(17)).toBe("adolescent");
    expect(lifeStage(18)).toBe("adult");
    expect(lifeStage(64)).toBe("adult");
    expect(lifeStage(65)).toBe("older-adult");
    expect(lifeStage(90)).toBe("older-adult");
  });

  it("returns null for an unknown age (the one documented null policy)", () => {
    expect(lifeStage(null)).toBeNull();
    expect(lifeStage(undefined)).toBeNull();
    expect(lifeStage(-1)).toBeNull();
    expect(lifeStage(NaN)).toBeNull();
  });

  it("boundaries are contiguous and ordered", () => {
    expect(INFANT_MAX_AGE).toBeLessThan(PEDIATRIC_BP_MAX_AGE);
    expect(PEDIATRIC_BP_MAX_AGE).toBeLessThan(ADULT_MIN_AGE);
    expect(ADULT_MIN_AGE).toBeLessThan(GROWTH_CHART_MAX_AGE);
    expect(GROWTH_CHART_MAX_AGE).toBeLessThan(OLDER_ADULT_MIN_AGE);
  });
});

describe("isAdultForClinical — adult-population statistical floor (18)", () => {
  it("is true at/over 18, false for a minor, HIDES on unknown age", () => {
    expect(isAdultForClinical(18)).toBe(true);
    expect(isAdultForClinical(40)).toBe(true);
    expect(isAdultForClinical(17)).toBe(false);
    expect(isAdultForClinical(0)).toBe(false);
    // Hides on missing data — never present an adult-validated number without a
    // known adult age.
    expect(isAdultForClinical(null)).toBe(false);
    expect(isAdultForClinical(undefined)).toBe(false);
  });
});

describe("isMinor — legal minor (< 18)", () => {
  it("is true under 18, false at/over 18 and on unknown age (adult default)", () => {
    expect(isMinor(0)).toBe(true);
    expect(isMinor(17)).toBe(true);
    expect(isMinor(18)).toBe(false);
    expect(isMinor(40)).toBe(false);
    expect(isMinor(null)).toBe(false);
  });
});

describe("isAdultBpRegime — BP interpretation line (13)", () => {
  it("switches to adult thresholds at 13, keeps pediatric below", () => {
    expect(isAdultBpRegime(13)).toBe(true);
    expect(isAdultBpRegime(14)).toBe(true);
    expect(isAdultBpRegime(12)).toBe(false);
    expect(isAdultBpRegime(1)).toBe(false);
  });
  it("defaults an unknown age to the adult regime (conservative)", () => {
    expect(isAdultBpRegime(null)).toBe(true);
    expect(isAdultBpRegime(undefined)).toBe(true);
  });
});

describe("isGrowthTracked — Body-tab growth line (< 20)", () => {
  it("is true through 19, false at 20 and on unknown age (adult layout)", () => {
    expect(isGrowthTracked(0)).toBe(true);
    expect(isGrowthTracked(19)).toBe(true);
    expect(isGrowthTracked(20)).toBe(false);
    expect(isGrowthTracked(40)).toBe(false);
    expect(isGrowthTracked(null)).toBe(false);
  });
});

describe("isFoodLoggingRelevant — nutrition logger line (≥ 1, or unknown)", () => {
  it("hides only on a positive infant match", () => {
    expect(isFoodLoggingRelevant(0)).toBe(false);
    expect(isFoodLoggingRelevant(0.5)).toBe(false);
  });
  it("is eligible for every non-infant known age", () => {
    expect(isFoodLoggingRelevant(INFANT_MAX_AGE)).toBe(true); // exactly 1 y
    expect(isFoodLoggingRelevant(4)).toBe(true);
    expect(isFoodLoggingRelevant(12)).toBe(true);
    expect(isFoodLoggingRelevant(40)).toBe(true);
  });
  it("is eligible on unknown age (never hides on missing data)", () => {
    expect(isFoodLoggingRelevant(null)).toBe(true);
    expect(isFoodLoggingRelevant(undefined)).toBe(true);
  });
});

// Parity guard (#494 proposal item 4): every domain age constant is a NAMED member
// of the one model, not a private magic number that can drift back apart.
describe("domain constants stay bound to the life-stage model", () => {
  it("fitness-norm adult floor === the model's adult floor (18)", () => {
    expect(FITNESS_ADULT_MIN_AGE).toBe(ADULT_MIN_AGE);
  });
  it("PhenoAge floor === the model's adult floor (18)", () => {
    expect(PHENOAGE_MIN_AGE).toBe(ADULT_MIN_AGE);
  });
  it("BP adult-regime age === the child→adolescent boundary (13)", () => {
    expect(ADULT_BP_AGE).toBe(PEDIATRIC_BP_MAX_AGE);
  });
  it("growth-metrics ceiling === the model's growth-chart ceiling (20)", () => {
    expect(GROWTH_METRICS_CEILING).toBe(GROWTH_CHART_MAX_AGE);
  });
  it("the growth-chart data ceiling (240 mo) === 20 y, the model's growth line", () => {
    expect(MAX_AGE_MONTHS).toBe(GROWTH_CHART_MAX_AGE * 12);
  });

  // Output-level parity (#505): the BP card's rendered regime (pediatricBpContext's
  // adultRegime) must call the shared isAdultBpRegime, not re-derive its own copy —
  // the constant-equality check above can't catch a divergence in flooring or
  // null-age handling. Assert the two functions agree across the pediatric window.
  it("pediatricBpContext.adultRegime === isAdultBpRegime for every pediatric age", () => {
    for (const ageYears of [1, 5, 12, 12.5, 13, 13.5, 14, 17]) {
      const ctx = pediatricBpContext("systolic", 100, {
        sex: "male",
        ageYears,
        heightPercentile: 50,
      });
      expect(ctx).not.toBeNull();
      expect(ctx!.adultRegime).toBe(isAdultBpRegime(ageYears));
    }
  });
});
