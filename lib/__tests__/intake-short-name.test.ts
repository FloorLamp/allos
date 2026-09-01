import { describe, it, expect } from "vitest";
import {
  INTAKE_SHORT_NAMES,
  intakeItemShortLabel,
  intakeShortLabels,
  intakeShortName,
  normalizeIntakeName,
  shortLabelAnnouncement,
} from "@/lib/intake-short-name";

describe("intakeShortName", () => {
  it("maps curated names to their short forms", () => {
    expect(intakeShortName("Coenzyme Q10")).toBe("CoQ10");
    expect(intakeShortName("Vitamin D3 + K2")).toBe("D3+K2");
    expect(intakeShortName("Vitamin D3")).toBe("D3");
    expect(intakeShortName("Vitamin B complex (B6, B12, Folate)")).toBe(
      "B-Complex"
    );
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

// The set-aware entry point. Shortening is MANY-TO-ONE, so the single-item resolver
// cannot see the sibling it lands on top of — and two identical labels over two
// different dose ids is a wrong-subject hazard on any control whose tap writes.
describe("intakeShortLabels", () => {
  const supp = (name: string, product?: string) => ({
    name,
    kind: "supplement" as const,
    product: product ?? null,
  });

  it("shortens freely when nothing collides", () => {
    expect(
      intakeShortLabels([supp("Coenzyme Q10"), supp("Creatine Monohydrate")])
    ).toEqual(["CoQ10", "Creatine"]);
  });

  it("drops BOTH sides of a curated alias collision back to the full name", () => {
    // The map aliases these deliberately — same substance, one short form.
    expect(
      intakeShortLabels([supp("Coenzyme Q10"), supp("Ubiquinone")])
    ).toEqual(["Coenzyme Q10", "Ubiquinone"]);
  });

  it("resolves a shortened name colliding with an item literally named that", () => {
    // The wider class: most short forms are plausible names on their own, so a
    // collision needs only ONE of the pair to have been shortened.
    expect(
      intakeShortLabels([supp("Creatine Monohydrate"), supp("Creatine")])
    ).toEqual(["Creatine Monohydrate", "Creatine"]);
  });

  it("resolves a product-derived collision, which needs no curated entry", () => {
    expect(
      intakeShortLabels([
        supp("Astaxanthin/Lutein/Zeaxanthin", "Eye Health+"),
        supp("Bilberry & Lutein Complex", "Eye Health+"),
      ])
    ).toEqual(["Astaxanthin/Lutein/Zeaxanthin", "Bilberry & Lutein Complex"]);
  });

  it("compares in the lookup's own normalization, so case is not an escape", () => {
    expect(intakeShortLabels([supp("Coenzyme Q10"), supp("coq10")])).toEqual([
      "Coenzyme Q10",
      "coq10",
    ]);
  });

  it("only lengthens the colliding pair, never the whole set", () => {
    expect(
      intakeShortLabels([
        supp("Coenzyme Q10"),
        supp("Ubiquinone"),
        supp("Creatine Monohydrate"),
      ])
    ).toEqual(["Coenzyme Q10", "Ubiquinone", "Creatine"]);
  });

  it("leaves an identical-FULL-name pair identical — a state it neither makes nor fixes", () => {
    // Two separately managed items with the same name are already qualified by the
    // dose detail beside them on every intake surface; falling back cannot help.
    expect(
      intakeShortLabels([supp("Magnesium Citrate"), supp("Magnesium Citrate")])
    ).toEqual(["Magnesium Citrate", "Magnesium Citrate"]);
  });

  it("counts a medication's untouched name as a collidable label", () => {
    // A medication is never shortened, so it collides as its own full name — and
    // the SUPPLEMENT beside it is the side that must lengthen.
    expect(
      intakeShortLabels([
        { name: "Creatine", kind: "medication", product: null },
        supp("Creatine Monohydrate"),
      ])
    ).toEqual(["Creatine", "Creatine Monohydrate"]);
  });

  // #2858 review pass 2, R2. A full name can BE another item's surviving short
  // form, so one count-and-substitute pass can hand back the collision it just
  // resolved. The product pair lengthens onto "CoQ10", which the third item was
  // still wearing; only running to a fixed point separates all three.
  it("re-resolves a collision its own fallback creates", () => {
    expect(
      intakeShortLabels([
        { name: "CoQ10", kind: "supplement", product: "Ubi" },
        { name: "Astaxanthin Complex", kind: "supplement", product: "Ubi" },
        { name: "Coenzyme Q10", kind: "supplement", product: null },
      ])
    ).toEqual(["CoQ10", "Astaxanthin Complex", "Coenzyme Q10"]);
  });

  it("leaves no two labels equal on the case its own fallback broke", () => {
    // The property the surfaces actually depend on, stated as a property: after
    // resolution NOTHING in the set shares a label with anything else.
    const labels = intakeShortLabels([
      { name: "CoQ10", kind: "supplement", product: "Ubi" },
      { name: "Astaxanthin Complex", kind: "supplement", product: "Ubi" },
      { name: "Coenzyme Q10", kind: "supplement", product: null },
    ]);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("is positional and total — one label per input, empty in, empty out", () => {
    expect(intakeShortLabels([])).toEqual([]);
    const items = [supp("Coenzyme Q10"), supp("Ubiquinone"), supp("Zinc")];
    expect(intakeShortLabels(items)).toHaveLength(items.length);
  });
});

describe("shortLabelAnnouncement (#2858's other half)", () => {
  // The compact form LEADS so a speech user can target what they see; the full record
  // name follows so the shortening loses no identity. Nothing is appended when there
  // is nothing to add, which is what keeps an unabbreviated chip from announcing its
  // own visible text twice.
  it.each([
    {
      label: "CoQ10 · Bedtime",
      full: "Coenzyme Q10 · Bedtime",
      expected: "CoQ10 · Bedtime — Coenzyme Q10 · Bedtime",
    },
    {
      label: "Aggregate Vitamin D · 1 tab",
      full: undefined,
      expected: "Aggregate Vitamin D · 1 tab",
    },
    { label: "Magnesium", full: "Magnesium", expected: "Magnesium" },
  ])("$label", ({ label, full, expected }) => {
    expect(shortLabelAnnouncement(label, full)).toBe(expected);
  });
});
