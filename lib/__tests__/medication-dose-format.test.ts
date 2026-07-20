import { describe, expect, it } from "vitest";
import {
  formatMedicationDoseLine,
  formatMedicationDoseProduct,
  medicationProductDoseLabel,
} from "@/lib/medication-dose-format";
import { PRN_DEFAULT_ENTRIES } from "@/lib/datasets/prn-defaults";

const CURATED_FORMULATIONS = PRN_DEFAULT_ENTRIES.flatMap((entry) =>
  (entry.pediatric?.formulations ?? []).map((formulation) => ({
    medication: entry.label,
    ...formulation,
  }))
);

describe("formatMedicationDoseProduct", () => {
  it("shows the selected liquid dose as mg and its matching volume", () => {
    expect(
      formatMedicationDoseProduct(
        "160 mg",
        "Children's oral suspension (160 mg / 5 mL)"
      )
    ).toBe("160 mg / 5 mL");
    expect(
      formatMedicationDoseProduct(
        "240 mg",
        "Children's oral suspension (160 mg / 5 mL)"
      )
    ).toBe("240 mg / 7.5 mL");
  });

  it.each(CURATED_FORMULATIONS)(
    "parses the full $medication formulation catalog entry $slug",
    ({ label, mgPerMl }) => {
      const parsed = medicationProductDoseLabel(label);
      expect(parsed).not.toBeNull();
      expect(parsed).not.toContain("(");
      expect(parsed).not.toContain(")");

      const ratio = parsed?.match(
        /^(\d+(?:\.\d+)?)\s*mg\s*\/\s*(\d+(?:\.\d+)?)\s*mL$/i
      );
      expect(ratio, `Unparseable concentration: ${label}`).not.toBeNull();
      expect(Number(ratio?.[1]) / Number(ratio?.[2])).toBeCloseTo(mgPerMl);

      // The formulation scales to the selected dose rather than hiding it behind the
      // package concentration.
      const selectedMg = mgPerMl * 7.5;
      expect(formatMedicationDoseProduct(`${selectedMg} mg`, label)).toBe(
        `${selectedMg} mg / 7.5 mL`
      );
    }
  );

  it("keeps arbitrary product text intact when it has no concentration ratio", () => {
    expect(medicationProductDoseLabel("Custom compounded chewable")).toBe(
      "Custom compounded chewable"
    );
  });

  it("handles either field alone and collapses exact duplicates", () => {
    expect(formatMedicationDoseProduct(null, "160 mg / 5 mL")).toBe(
      "160 mg / 5 mL"
    );
    expect(formatMedicationDoseProduct("10 mg", "10 mg")).toBe("10 mg");
    expect(formatMedicationDoseProduct(null, null)).toBeNull();
  });
});

describe("formatMedicationDoseLine", () => {
  it("keeps the amount and normalizes a named schedule bucket", () => {
    expect(
      formatMedicationDoseLine({
        amount: "1 tablet",
        timeOfDay: "morning",
        asNeeded: false,
        timeFormat: "24h",
      })
    ).toBe("1 tablet · Morning");
  });

  it("uses the login clock preference for exact times", () => {
    expect(
      formatMedicationDoseLine({
        amount: "10 mg",
        timeOfDay: "17:00",
        asNeeded: false,
        timeFormat: "12h",
      })
    ).toBe("10 mg · 5:00 PM");
  });

  it("shows only the amount for an as-needed dose", () => {
    expect(
      formatMedicationDoseLine({
        amount: "400 mg",
        timeOfDay: "Anytime",
        asNeeded: true,
        timeFormat: "24h",
      })
    ).toBe("400 mg");
  });

  it("includes the saved formulation before the schedule", () => {
    expect(
      formatMedicationDoseLine({
        amount: "160 mg",
        product: "Children's oral suspension (160 mg / 5 mL)",
        timeOfDay: "Evening",
        asNeeded: false,
        timeFormat: "12h",
      })
    ).toBe("160 mg / 5 mL · Evening");
  });
});
