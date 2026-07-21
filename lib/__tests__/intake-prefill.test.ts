import { describe, it, expect } from "vitest";
import { resolveIntakePrefill } from "@/lib/intake-prefill";
import { getMedicationInfo } from "@/lib/medication-info";
import { prnDefaultsFor } from "@/lib/prn-defaults";
import type { PediatricFormContext } from "@/lib/prn-dosing";

// The pure selection-prefill resolver (#846): picking a med suggests every knowable
// field as an editable, MARKED value that NEVER clobbers a touched field; an absent
// dataset prefills nothing; a child profile's dose comes from the #798 weight band.

const ibuInfo = getMedicationInfo("Ibuprofen");
const ibuPrn = prnDefaultsFor({ name: "Ibuprofen", rxcui: null });

describe("resolveIntakePrefill", () => {
  it("prefills the full knowable set for a catalogued OTC med (adult)", () => {
    const pf = resolveIntakePrefill({ info: ibuInfo, prn: ibuPrn });
    // Ibuprofen: PRN, with food, adult low dose 200 mg, 6h / max 4 (all cited).
    expect(pf.asNeeded).toBe(true);
    expect(pf.foodTiming).toBe("with_food");
    expect(pf.doseAmount).toBe("200 mg");
    expect(pf.minIntervalHours).toBe(6);
    expect(pf.maxDailyCount).toBe(4);
    expect(pf.brandSuggestions).toEqual(
      expect.arrayContaining(["Advil", "Motrin"])
    );
    // Every suggested field is marked so the form can badge it "from label defaults".
    expect(pf.marked).toEqual(
      expect.arrayContaining([
        "asNeeded",
        "foodTiming",
        "doseAmount",
        "minIntervalHours",
        "maxDailyCount",
      ])
    );
  });

  it("never clobbers a field the user already touched", () => {
    const pf = resolveIntakePrefill({
      info: ibuInfo,
      prn: ibuPrn,
      touched: { asNeeded: true, doseAmount: true },
    });
    expect(pf.asNeeded).toBeUndefined();
    expect(pf.doseAmount).toBeUndefined();
    expect(pf.marked).not.toContain("asNeeded");
    expect(pf.marked).not.toContain("doseAmount");
    // Untouched fields still prefill.
    expect(pf.minIntervalHours).toBe(6);
    expect(pf.marked).toContain("minIntervalHours");
  });

  it("an absent entry prefills nothing (never a guess)", () => {
    const pf = resolveIntakePrefill({ info: null, prn: null });
    expect(pf.marked).toEqual([]);
    expect(pf.asNeeded).toBeUndefined();
    expect(pf.doseAmount).toBeUndefined();
    expect(pf.minIntervalHours).toBeUndefined();
    expect(pf.brandSuggestions).toEqual([]);
  });

  it("only encodes conventions the dataset carries (typical-less med)", () => {
    // A statin-style entry with a `typical.timeOfDay` but no PRN defaults prefills the
    // convention and nothing dose-related (no prn ⇒ no dose/interval/max).
    const simInfo = getMedicationInfo("Simvastatin");
    const pf = resolveIntakePrefill({ info: simInfo, prn: null });
    expect(pf.timeOfDay).toBe("Evening");
    expect(pf.asNeeded).toBeUndefined();
    expect(pf.doseAmount).toBeUndefined();
    expect(pf.minIntervalHours).toBeUndefined();
    expect(pf.marked).toEqual(["timeOfDay"]);
  });

  it("a child profile's dose comes from the #798 weight band, not the adult figure", () => {
    // A ~24 lb toddler (age 24 mo, fresh weight) bands to ibuprofen 100 mg — distinct
    // from the adult 200 mg low dose.
    const pediatric: PediatricFormContext = {
      ageMonths: 24,
      weightKg: 11, // ≈ 24.3 lb → the 24 lb band
      weightDate: "2026-07-10",
      weightUnit: "lb",
      today: "2026-07-16",
    };
    const pf = resolveIntakePrefill({ info: ibuInfo, prn: ibuPrn, pediatric });
    expect(pf.doseAmount).toBe("100 mg");
    expect(pf.marked).toContain("doseAmount");
    // The non-dose conventions still prefill for the child.
    expect(pf.asNeeded).toBe(true);
    expect(pf.minIntervalHours).toBe(6);
  });

  it("a child band refusal (no weight) prefills no dose, never the adult figure", () => {
    const pediatric: PediatricFormContext = {
      ageMonths: 24,
      weightKg: null,
      weightDate: null,
      weightUnit: "lb",
      today: "2026-07-16",
    };
    const pf = resolveIntakePrefill({ info: ibuInfo, prn: ibuPrn, pediatric });
    expect(pf.doseAmount).toBeUndefined();
    expect(pf.marked).not.toContain("doseAmount");
    // Interval/max (age-independent label facts) still prefill.
    expect(pf.minIntervalHours).toBe(6);
  });
});
