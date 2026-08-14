import { describe, it, expect } from "vitest";
import {
  INTAKE_SHORT_NAMES,
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
