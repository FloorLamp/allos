import { describe, it, expect } from "vitest";
import { prnDefaultEntries, prnDefaultsFor } from "@/lib/prn-defaults";

// Dataset test for the curated OTC PRN defaults (#798) — the medication-info /
// food-drug-interactions treatment: every entry is cited, the matcher works by
// RxNorm ingredient CUI AND name fallback, and — the load-bearing safety invariant —
// ASPIRIN structurally has NO pediatric entry (Reye's syndrome).

describe("prn-defaults dataset", () => {
  const entries = prnDefaultEntries();

  it("every entry carries a citation and valid adult label numbers", () => {
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.source, `${e.key} must cite a source`).toBeTruthy();
      expect(e.rxcuis.length).toBeGreaterThan(0);
      expect(e.adult.minIntervalHours).toBeGreaterThan(0);
      expect(e.adult.maxDailyCount).toBeGreaterThan(0);
      expect(e.adult.maxDailyMg).toBeGreaterThan(0);
    }
  });

  it("ibuprofen and acetaminophen carry a pediatric weight-band table", () => {
    for (const key of ["ibuprofen", "acetaminophen"]) {
      const e = entries.find((x) => x.key === key);
      expect(e, `${key} present`).toBeTruthy();
      expect(e!.pediatric, `${key} has a pediatric table`).toBeTruthy();
      expect(e!.pediatric!.bands.length).toBeGreaterThan(0);
      expect(e!.pediatric!.minAgeMonths).toBeGreaterThan(0);
      // Bands ascend by minLbs (the lookup relies on picking the highest ≤ weight).
      const mins = e!.pediatric!.bands.map((b) => b.minLbs);
      expect([...mins].sort((a, b) => a - b)).toEqual(mins);
    }
  });

  it("ASPIRIN is structurally excluded from pediatric dosing (Reye's)", () => {
    const aspirin = entries.find((e) => e.key === "aspirin");
    expect(aspirin, "aspirin is in the dataset (adult only)").toBeTruthy();
    expect(aspirin!.pediatric).toBeUndefined();
    // And NO entry that looks like aspirin may ever carry a pediatric table.
    for (const e of entries) {
      const looksAspirin =
        e.key === "aspirin" ||
        e.synonyms.some((s) => /aspirin|acetylsalicylic/i.test(s));
      if (looksAspirin) expect(e.pediatric).toBeUndefined();
    }
  });

  it("matches by RxNorm ingredient CUI (authoritative)", () => {
    const hit = prnDefaultsFor({ name: "Some Brand", rxcui: "5640" });
    expect(hit?.key).toBe("ibuprofen");
  });

  it("matches by ingredient CUI in the cached ingredient list (#279)", () => {
    const hit = prnDefaultsFor({
      name: "Unknown combo",
      rxcui: "99999",
      rxcuiIngredients: ["161"],
    });
    expect(hit?.key).toBe("acetaminophen");
  });

  it("falls back to a name/synonym match when no CUI", () => {
    expect(prnDefaultsFor({ name: "Advil 200mg", rxcui: null })?.key).toBe(
      "ibuprofen"
    );
    expect(prnDefaultsFor({ name: "Tylenol", rxcui: null })?.key).toBe(
      "acetaminophen"
    );
  });

  it("returns null for an unknown ingredient", () => {
    expect(prnDefaultsFor({ name: "Metformin", rxcui: null })).toBeNull();
  });
});
