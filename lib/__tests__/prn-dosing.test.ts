import { describe, it, expect } from "vitest";
import {
  bandForWeightLbs,
  bandRangeLabel,
  isWeightStale,
  weightStalenessDays,
  mlForBand,
  kgToLbs,
  pediatricDoseSuggestion,
} from "@/lib/prn-dosing";
import { prnDefaultsFor, type PediatricBand } from "@/lib/prn-defaults";

const IBUPROFEN = prnDefaultsFor({ name: "Ibuprofen", rxcui: "5640" })!;
const ASPIRIN = prnDefaultsFor({ name: "Aspirin", rxcui: "1191" })!;

// Ibuprofen bands: 24→100, 36→150, 48→200, 60→250, 72→300 (mg).
const BANDS: PediatricBand[] = IBUPROFEN.pediatric!.bands;

describe("bandForWeightLbs — conservative lower-band rounding", () => {
  it("a weight inside a band maps to that band", () => {
    expect(bandForWeightLbs(BANDS, 30)?.mg).toBe(100);
    expect(bandForWeightLbs(BANDS, 40)?.mg).toBe(150);
  });

  it("a weight BETWEEN two label bands lands on the LOWER band", () => {
    // 35.5 lb is between the 24–35 band and the 36–47 band → 100 mg (lower).
    expect(bandForWeightLbs(BANDS, 35.5)?.mg).toBe(100);
    // 47.9 lb is still in the 36–47 band → 150 mg, not 200.
    expect(bandForWeightLbs(BANDS, 47.9)?.mg).toBe(150);
  });

  it("exactly on a band's lower bound uses that band", () => {
    expect(bandForWeightLbs(BANDS, 36)?.mg).toBe(150);
    expect(bandForWeightLbs(BANDS, 72)?.mg).toBe(300);
  });

  it("below the smallest band is a refusal (null)", () => {
    expect(bandForWeightLbs(BANDS, 20)).toBeNull();
  });

  it("above the top band stays on the top band (most conservative labeled dose)", () => {
    expect(bandForWeightLbs(BANDS, 120)?.mg).toBe(300);
  });
});

describe("bandRangeLabel", () => {
  it("renders an inner band as a range and the top band with +", () => {
    expect(bandRangeLabel(BANDS, BANDS[0])).toBe("24–35 lb");
    expect(bandRangeLabel(BANDS, BANDS[BANDS.length - 1])).toBe("72+ lb");
  });
});

describe("weight freshness gate", () => {
  it("younger children go stale sooner", () => {
    expect(weightStalenessDays(6)).toBeLessThan(weightStalenessDays(36));
    expect(weightStalenessDays(36)).toBeLessThan(weightStalenessDays(120));
  });

  it("a weight older than the threshold is stale; a recent one is fresh", () => {
    // ageMonths 6 → 60-day threshold.
    expect(isWeightStale(6, "2026-01-01", "2026-04-01")).toBe(true); // ~90 days
    expect(isWeightStale(6, "2026-06-01", "2026-07-01")).toBe(false); // 30 days
  });

  it("a missing recorded date reads as stale", () => {
    expect(isWeightStale(6, null, "2026-07-01")).toBe(true);
  });
});

describe("mlForBand — formulation-gated volume", () => {
  it("null without a formulation", () => {
    expect(mlForBand(null, 200)).toBeNull();
  });

  it("mL = mg / concentration once a formulation is picked", () => {
    // Children's suspension 100 mg / 5 mL = 20 mg/mL → 200 mg = 10 mL.
    const susp = IBUPROFEN.pediatric!.formulations.find(
      (f) => f.slug === "childrens_susp_100_5"
    )!;
    expect(mlForBand(susp, 200)).toBe(10);
    // Infants' drops 50 mg / 1.25 mL = 40 mg/mL → 100 mg = 2.5 mL.
    const drops = IBUPROFEN.pediatric!.formulations.find(
      (f) => f.slug === "infant_drops_50_1_25"
    )!;
    expect(mlForBand(drops, 100)).toBe(2.5);
  });
});

describe("kgToLbs", () => {
  it("converts canonical kg to pounds", () => {
    expect(kgToLbs(10)).toBeCloseTo(22.05, 1);
  });
});

describe("pediatricDoseSuggestion — orchestrated lookup", () => {
  const today = "2026-07-15";
  // 13.6 kg ≈ 30 lb → the 24–35 band (100 mg for ibuprofen). ~4 years old.
  const base = {
    entry: IBUPROFEN,
    ageMonths: 48,
    weightKg: 13.6,
    weightDate: "2026-06-01",
    today,
  };

  it("returns the band dose for an in-range child with a fresh weight", () => {
    const r = pediatricDoseSuggestion(base);
    expect(r.kind).toBe("dose");
    if (r.kind === "dose") {
      expect(r.mg).toBe(100);
      expect(r.ml).toBeNull(); // mg only until a formulation is picked
      expect(r.caveat).toMatch(/label/i);
    }
  });

  it("mL only appears once a formulation is picked", () => {
    const r = pediatricDoseSuggestion({
      ...base,
      formulationSlug: "childrens_susp_100_5",
    });
    expect(r.kind).toBe("dose");
    if (r.kind === "dose") expect(r.ml).toBe(5); // 100 mg / 20 mg/mL
  });

  it("HARD age gate → ask-doctor (ibuprofen under 6 months)", () => {
    const r = pediatricDoseSuggestion({ ...base, ageMonths: 4 });
    expect(r.kind).toBe("ask-doctor");
  });

  it("no recorded weight → need-weight", () => {
    const r = pediatricDoseSuggestion({ ...base, weightKg: null });
    expect(r.kind).toBe("need-weight");
  });

  it("stale weight → prompt to update BEFORE a band is suggested", () => {
    const r = pediatricDoseSuggestion({ ...base, weightDate: "2026-01-01" });
    expect(r.kind).toBe("stale-weight");
  });

  it("below the smallest band → ask-doctor refusal, never an extrapolated dose", () => {
    // 8 kg ≈ 17.6 lb, below the 24-lb smallest band; age passes (12 months).
    const r = pediatricDoseSuggestion({
      ...base,
      ageMonths: 12,
      weightKg: 8,
    });
    expect(r.kind).toBe("ask-doctor");
  });

  it("aspirin has no pediatric table → no-pediatric (structurally cannot dose)", () => {
    const r = pediatricDoseSuggestion({ ...base, entry: ASPIRIN });
    expect(r.kind).toBe("no-pediatric");
  });
});
