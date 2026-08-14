import { describe, it, expect } from "vitest";
import {
  INTAKE_SHORT_NAMES,
  intakeItemShortLabel,
  intakeShortName,
  normalizeIntakeName,
} from "@/lib/intake-short-name";

describe("intakeShortName", () => {
  it("maps curated names to their short forms", () => {
    expect(intakeShortName("Coenzyme Q10")).toBe("CoQ10");
    expect(intakeShortName("Vitamin D3 + K2")).toBe("D3+K2");
    expect(intakeShortName("Vitamin D3")).toBe("D3");
    expect(intakeShortName("N-Acetyl Cysteine")).toBe("NAC");
    expect(intakeShortName("Creatine Monohydrate")).toBe("Creatine");
    expect(intakeShortName("P-5-P (Pyridoxal-5-Phosphate)")).toBe("P5P");
    expect(intakeShortName("Stinging Nettle")).toBe("Nettle");
    expect(intakeShortName("PreserVision AREDS 2")).toBe("AREDS 2");
  });

  it("matches case-, whitespace- and separator-insensitively", () => {
    expect(intakeShortName("COENZYME Q10")).toBe("CoQ10");
    expect(intakeShortName("  vitamin  d3 ")).toBe("D3");
    expect(intakeShortName("Vitamin D3+K2")).toBe("D3+K2");
    expect(intakeShortName("Vitamin D3 & K2")).toBe("D3+K2");
  });

  it("resolves aliases of one substance to one short name", () => {
    expect(intakeShortName("Ubiquinone")).toBe("CoQ10");
    expect(intakeShortName("Cholecalciferol (Vitamin D3)")).toBe("D3");
    expect(intakeShortName("Betaine (TMG)")).toBe("TMG");
  });

  it("passes unknown and custom names through whole", () => {
    expect(intakeShortName("Ibuprofen")).toBe("Ibuprofen");
    expect(intakeShortName("Dr. Kim's AM Stack")).toBe("Dr. Kim's AM Stack");
    expect(intakeShortName("")).toBe("");
  });

  it("shortens magnesium forms without dropping the form", () => {
    expect(intakeShortName("Magnesium Glycinate")).toBe("Mag glycinate");
    expect(intakeShortName("Magnesium L-Threonate")).toBe("Mag threonate");
    // A bare "Magnesium" is already short and has no entry.
    expect(intakeShortName("Magnesium")).toBe("Magnesium");
    // The forms stay tellable apart — never a shared bare "Mag"/"Magnesium".
    const forms = [
      "Magnesium Glycinate",
      "Magnesium Citrate",
      "Magnesium L-Threonate",
      "Magnesium Malate",
      "Magnesium Oxide",
      "Magnesium Taurate",
    ].map(intakeShortName);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("keeps distinct substances distinct (the K2 forms)", () => {
    expect(intakeShortName("Vitamin K2 (MK-4)")).not.toBe(
      intakeShortName("Vitamin K2 (MK-7)")
    );
  });

  // The map's structural invariants, so a future entry can't silently break the
  // lookup or the pass-through contract.
  it("stores every key in normalized form", () => {
    for (const key of Object.keys(INTAKE_SHORT_NAMES)) {
      expect(normalizeIntakeName(key)).toBe(key);
    }
  });

  it("never lengthens a name", () => {
    for (const [key, short] of Object.entries(INTAKE_SHORT_NAMES)) {
      expect(short.length).toBeGreaterThan(0);
      expect(short.length).toBeLessThanOrEqual(key.length);
    }
  });

  it("is idempotent — a short form shortens to itself", () => {
    for (const short of Object.values(INTAKE_SHORT_NAMES)) {
      expect(intakeShortName(short)).toBe(short);
    }
  });
});

describe("intakeItemShortLabel", () => {
  it("falls back to a supplement's shorter product name", () => {
    // The "name carries the composition, product carries the identity" shape.
    expect(
      intakeItemShortLabel({
        name: "Astaxanthin/Lutein/Zeaxanthin",
        kind: "supplement",
        product: "Eye Health+",
      })
    ).toBe("Eye Health+");
  });

  it("prefers the curated form over the product", () => {
    expect(
      intakeItemShortLabel({
        name: "Vitamin D3 + K2",
        kind: "supplement",
        product: "D/K2 5000",
      })
    ).toBe("D3+K2");
  });

  it("never substitutes a medication's product (it is a formulation)", () => {
    expect(
      intakeItemShortLabel({
        name: "Acetaminophen",
        kind: "medication",
        product: "Chewable",
      })
    ).toBe("Acetaminophen");
  });

  it("never shortens a medication's NAME either, even when the map knows it", () => {
    // Several map entries are also drug names — an Rx ergocalciferol, an OTC
    // magnesium citrate laxative. The kind gate, not the map's curation, is
    // what keeps a drug name whole on a button.
    expect(
      intakeItemShortLabel({
        name: "Ergocalciferol (Vitamin D2)",
        kind: "medication",
      })
    ).toBe("Ergocalciferol (Vitamin D2)");
    expect(
      intakeItemShortLabel({ name: "Magnesium Citrate", kind: "medication" })
    ).toBe("Magnesium Citrate");
    // The same names shorten for a supplement row.
    expect(
      intakeItemShortLabel({ name: "Magnesium Citrate", kind: "supplement" })
    ).toBe("Mag citrate");
  });

  it("ignores a product that is not shorter, and copes with absences", () => {
    expect(
      intakeItemShortLabel({
        name: "Zinc",
        kind: "supplement",
        product: "Zinc Picolinate 30mg 90 caps",
      })
    ).toBe("Zinc");
    expect(intakeItemShortLabel({ name: "Custom Blend" })).toBe("Custom Blend");
    expect(intakeItemShortLabel({ name: "Custom Blend", product: "  " })).toBe(
      "Custom Blend"
    );
  });
});
