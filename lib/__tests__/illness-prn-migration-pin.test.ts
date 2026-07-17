import { describe, expect, it } from "vitest";
import { illnessThresholdFor } from "@/lib/illness-thresholds";
import {
  prnDefaultsFor,
  redoseLabelDefaults,
  isAntipyreticIntakeItem,
} from "@/lib/prn-defaults";

// Behavior-preservation pins for the illness-thresholds + prn-defaults migration onto
// the curated-dataset framework (issue #860 wave 2, unit 6). These back the #805
// illness-care findings and the #798 PRN dosing prefill; the migration reshaped the
// committed JSON into a framework envelope (top-level `symptoms`/`ingredients` →
// `entries`) and re-sourced the accessors through the framework modules. The exact
// CITED figures — the thing most at risk in a JSON reshape — must survive byte-for-byte.
// Pure — no DB/network. Synthetic item shapes only.

describe("illness-thresholds cited figures survive the migration", () => {
  it("preserves the fever entry's duration + infant band (verbatim source numbers)", () => {
    const fever = illnessThresholdFor("fever");
    expect(fever?.slug).toBe("fever");
    expect(fever?.duration?.days).toBe(3);
    expect(fever?.infantRule?.maxAgeMonths).toBe(3);
    // The infant band carries its OWN (stricter, AAP) source.
    expect(fever?.infantRule?.source).toMatch(/AAP|American Academy/i);
  });

  it("preserves the other cited duration day-counts", () => {
    expect(illnessThresholdFor("cough")?.duration?.days).toBe(7);
    expect(illnessThresholdFor("sore_throat")?.duration?.days).toBe(2);
    expect(illnessThresholdFor("diarrhea")?.duration?.days).toBe(2);
    // Diarrhea also carries the sustained-worsening trajectory rule.
    expect(illnessThresholdFor("diarrhea")?.trajectory?.days).toBe(2);
  });

  it("refuses a symptom with no cited entry (no finding, ever)", () => {
    expect(illnessThresholdFor("headache")).toBeNull();
    expect(illnessThresholdFor("weird custom symptom")).toBeNull();
  });
});

describe("prn-defaults cited figures + matching survive the migration", () => {
  it("preserves ibuprofen adult + pediatric label figures", () => {
    const ibu = prnDefaultsFor({ name: "Advil 200mg", rxcui: null });
    expect(ibu?.slug).toBe("ibuprofen");
    expect(ibu?.adult.minIntervalHours).toBe(6);
    expect(ibu?.adult.maxDailyCount).toBe(4);
    expect(ibu?.adult.maxDailyMg).toBe(1200);
    expect(ibu?.pediatric?.minAgeMonths).toBe(6);
    expect(ibu?.pediatric?.bands[0]).toEqual({ minLbs: 24, mg: 100 });
  });

  it("preserves the acetaminophen pediatric redose divergence (child max 5 vs adult 6)", () => {
    const apap = prnDefaultsFor({ name: "Tylenol", rxcui: null });
    expect(apap?.slug).toBe("acetaminophen");
    expect(apap?.adult.maxDailyCount).toBe(6);
    expect(apap?.pediatric?.maxDailyCount).toBe(5);
    // The child-label prefill picks the pediatric figures.
    const child = redoseLabelDefaults(apap!, true);
    expect(child).toEqual({
      minIntervalHours: 4,
      maxDailyCount: 5,
      tier: "pediatric",
      source: apap!.source,
    });
  });

  it("keeps aspirin adult-only (Reye's) — no pediatric prefill for a child", () => {
    const asa = prnDefaultsFor({ name: "Aspirin", rxcui: "1191" });
    expect(asa?.slug).toBe("aspirin");
    expect(asa?.pediatric).toBeUndefined();
    // A child profile REFUSES to prefill adult numbers (never guess below the floor).
    expect(redoseLabelDefaults(asa!, true)).toBeNull();
  });

  it("matches by RxCUI (authoritative) and cached ingredient CUI (#279)", () => {
    expect(prnDefaultsFor({ name: "Some Brand", rxcui: "5640" })?.slug).toBe(
      "ibuprofen"
    );
    expect(
      prnDefaultsFor({
        name: "Unknown combo",
        rxcui: "99999",
        rxcuiIngredients: ["161"],
      })?.slug
    ).toBe("acetaminophen");
    expect(prnDefaultsFor({ name: "Metformin", rxcui: null })).toBeNull();
  });

  it("classifies antipyretics vs non-antipyretics unchanged", () => {
    expect(isAntipyreticIntakeItem({ name: "Advil", rxcui: null })).toBe(true);
    expect(isAntipyreticIntakeItem({ name: "Tylenol", rxcui: null })).toBe(
      true
    );
    // Diphenhydramine (antihistamine) is NOT a fever reducer.
    expect(isAntipyreticIntakeItem({ name: "Benadryl", rxcui: null })).toBe(
      false
    );
  });
});
