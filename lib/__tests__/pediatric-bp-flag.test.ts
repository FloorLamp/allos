import { describe, expect, it } from "vitest";
import { reconciledFlag } from "@/lib/reference-range";
import { bpComponentFor } from "@/lib/bp-markers";
import { bpComponentFor as bpComponentForViaDataset } from "@/lib/bp-percentiles";
import { PEDIATRIC_BP_MAX_AGE } from "@/lib/life-stage";

// PEDIATRIC BLOOD PRESSURE IS A PERCENTILE, NOT A BAND (issue #2794).
//
// The defect: `Blood Pressure Systolic/Diastolic` carry only the ADULT 90–120 / 60–80
// interval and no `ranges_by_age`, so a 22-month-old's 98/54 — "Normal for age" on the
// AAP 2017 age/sex/height percentile the biomarker page already renders — was stored
// `low` and rendered red on the passport, the readings table and the timeline's
// out-of-range count, three cards below the percentile card saying it was normal.
//
// The ruling lives in the pure core so it covers the import follow-up, manual entry,
// the Health Connect ingest, the reprocess PREVIEW and the boot reconcile at once —
// the seed exclusion it replaces covered only the seed.
//
// SYNTHETIC ONLY: invented subjects and values. No PHI.

// The curated BP entries, as `canonical_result_definitions` holds them (the shape
// reconciledFlag judges against). `direction: lower_better` + an optimal_high is what
// the real rows carry, so the "would have been non-optimal" case is reachable too.
function bpEntry(component: "Systolic" | "Diastolic") {
  return {
    name: `Blood Pressure ${component}`,
    unit: "mmHg",
    direction: "lower_better" as const,
    ref_low: component === "Systolic" ? 90 : 60,
    ref_high: component === "Systolic" ? 120 : 80,
    ref_low_male: null,
    ref_high_male: null,
    ref_low_female: null,
    ref_high_female: null,
    optimal_low: null,
    optimal_high: component === "Systolic" ? 115 : 75,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
  };
}

const systolic = bpEntry("Systolic");
const diastolic = bpEntry("Diastolic");

// A non-BP vitals entry with the same shape, to prove the carve-out is keyed on the BP
// marker names and does not quietly exempt every pediatric vital.
const respRate = {
  name: "Respiratory Rate",
  unit: "/min",
  direction: "in_range" as const,
  ref_low: 12,
  ref_high: 20,
  ref_low_male: null,
  ref_high_male: null,
  ref_low_female: null,
  ref_high_female: null,
  optimal_low: null,
  optimal_high: null,
  optimal_low_male: null,
  optimal_high_male: null,
  optimal_low_female: null,
  optimal_high_female: null,
};

describe("pediatric BP defers to the AAP percentile (#2794)", () => {
  it("derives NO flag for a toddler's normal-for-age diastolic", () => {
    // The reported case: 22 months, 54 mmHg. Below the adult floor of 60, and the
    // reason the passport showed a red ▼.
    expect(
      reconciledFlag(null, 54, "mmHg", diastolic, null, 1)
    ).toBeUndefined();
    expect(reconciledFlag(null, 98, "mmHg", systolic, null, 1)).toBeUndefined();
  });

  it("CLEARS the adult-band flag already stored on such a row", () => {
    // The stored `low` is OUR claim (reconcileFlags owns the flag on every numeric BP
    // row — it re-runs on every import and on the demographics-change re-reconcile), so
    // it is ours to retire. Left alone it would outlive the judgement that made it.
    expect(reconciledFlag("low", 54, "mmHg", diastolic, null, 1)).toBeNull();
    expect(reconciledFlag("high", 132, "mmHg", systolic, null, 4)).toBeNull();
    expect(
      reconciledFlag("non-optimal-high", 118, "mmHg", systolic, null, 4)
    ).toBeNull();
  });

  it("leaves an absent or 'normal' flag alone rather than churning the row", () => {
    expect(
      reconciledFlag(null, 54, "mmHg", diastolic, null, 3)
    ).toBeUndefined();
    expect(
      reconciledFlag("normal", 54, "mmHg", diastolic, null, 3)
    ).toBeUndefined();
  });

  it("never touches a qualitative verdict", () => {
    // 'abnormal' returns before any of this (the numeric pass cannot restate it), and
    // 'immune' is not in its vocabulary either.
    expect(
      reconciledFlag("abnormal", 54, "mmHg", diastolic, null, 1)
    ).toBeUndefined();
    expect(
      reconciledFlag("immune", 54, "mmHg", diastolic, null, 1)
    ).toBeUndefined();
  });

  it("switches to the adult band at PEDIATRIC_BP_MAX_AGE, and treats an unknown age as adult", () => {
    // AAP itself switches from percentiles to static adult-style thresholds at 13.
    expect(
      reconciledFlag(
        null,
        54,
        "mmHg",
        diastolic,
        null,
        PEDIATRIC_BP_MAX_AGE - 1
      )
    ).toBeUndefined();
    expect(
      reconciledFlag(null, 54, "mmHg", diastolic, null, PEDIATRIC_BP_MAX_AGE)
    ).toBe("low");
    // No birthdate and no stored age → the conservative default the BP surfaces
    // already use, unchanged by this issue.
    expect(reconciledFlag(null, 54, "mmHg", diastolic)).toBe("low");
    expect(reconciledFlag(null, 54, "mmHg", diastolic, null, null)).toBe("low");
  });

  it("does not exempt other pediatric vitals — only the BP components", () => {
    // Respiratory rate has its own age-banded curation story; nothing here touches it.
    expect(reconciledFlag(null, 40, "/min", respRate, null, 1)).toBe("high");
    expect(bpComponentFor("Respiratory Rate")).toBeNull();
  });

  it("asks the ONE marker list — lib/bp-markers, re-exported by lib/bp-percentiles", () => {
    // The list was split out so the flag core can ask without importing the AAP
    // dataset; a second copy is exactly the drift the split exists to prevent.
    expect(bpComponentFor("Blood Pressure Systolic")).toBe("systolic");
    expect(bpComponentFor("Blood Pressure Diastolic")).toBe("diastolic");
    expect(bpComponentForViaDataset).toBe(bpComponentFor);
  });

  it("still judges an adult's BP exactly as before", () => {
    expect(reconciledFlag(null, 54, "mmHg", diastolic, null, 40)).toBe("low");
    expect(reconciledFlag(null, 130, "mmHg", systolic, null, 40)).toBe("high");
    expect(reconciledFlag(null, 118, "mmHg", systolic, null, 40)).toBe(
      "non-optimal-high"
    );
    expect(
      reconciledFlag(null, 110, "mmHg", systolic, null, 40)
    ).toBeUndefined();
  });

  it("does not let a printed adult range flag a child through the #2799 path", () => {
    // A pediatric visit's own document prints the ADULT interval beside the value
    // ("60-80"), because that is what the form says. The lab-stated flag must not
    // become a back door to the very judgement this issue removed — the carve-out
    // returns before any range, curated or printed, is consulted.
    expect(
      reconciledFlag(null, 54, "mmHg", diastolic, null, 1, null, "60-80")
    ).toBeUndefined();
    expect(
      reconciledFlag("low", 54, "mmHg", diastolic, null, 1, null, "60-80")
    ).toBeNull();
  });
});
