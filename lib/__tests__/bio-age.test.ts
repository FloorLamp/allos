import { describe, it, expect } from "vitest";
import {
  PHENOAGE_INPUT_NAMES,
  PHENOAGE_INPUT_COUNT,
  bioAgeDelta,
  bioAgeDeltaPhrase,
  paceOfAging,
  paceOfAgingPhrase,
  inputCompleteness,
  completenessChecklistMessage,
  isBioAgeHiddenForAge,
} from "../bio-age";

describe("PhenoAge input catalogue", () => {
  it("carries the nine analytes the formula consumes", () => {
    expect(PHENOAGE_INPUT_COUNT).toBe(9);
    expect(PHENOAGE_INPUT_NAMES).toHaveLength(9);
    // A couple of anchors so the checklist wording stays grounded in real names.
    expect(PHENOAGE_INPUT_NAMES).toContain("Albumin");
    expect(PHENOAGE_INPUT_NAMES).toContain("hs-CRP");
  });
});

describe("bioAgeDelta", () => {
  it("younger when biological age is below chronological", () => {
    const d = bioAgeDelta(46.8, 50);
    expect(d.direction).toBe("younger");
    expect(d.magnitudeYears).toBe(3.2);
    expect(d.deltaYears).toBe(-3.2);
    expect(d.bioAge).toBe(46.8);
    expect(d.chronoAge).toBe(50);
  });

  it("older when biological age exceeds chronological", () => {
    const d = bioAgeDelta(58.4, 55);
    expect(d.direction).toBe("older");
    expect(d.magnitudeYears).toBe(3.4);
    expect(d.deltaYears).toBe(3.4);
  });

  it("even when the rounded gap is zero", () => {
    const d = bioAgeDelta(50.03, 50);
    expect(d.direction).toBe("even");
    expect(d.magnitudeYears).toBe(0);
  });

  it("phrases the delta for the card", () => {
    expect(bioAgeDeltaPhrase(bioAgeDelta(46.8, 50))).toBe(
      "3.2 years younger than your calendar age of 50"
    );
    expect(bioAgeDeltaPhrase(bioAgeDelta(56, 55))).toBe(
      "1 year older than your calendar age of 55"
    );
    expect(bioAgeDeltaPhrase(bioAgeDelta(50, 50))).toBe(
      "about the same as your calendar age of 50"
    );
  });
});

describe("paceOfAging", () => {
  it("no complete draws → none", () => {
    const p = paceOfAging([]);
    expect(p.status).toBe("none");
    expect(p.slopePerYear).toBeNull();
    expect(paceOfAgingPhrase(p)).toBeNull();
  });

  it("a single draw shows the value with no slope", () => {
    const p = paceOfAging([{ date: "2024-01-01", bioAge: 47, chronoAge: 50 }]);
    expect(p.status).toBe("single");
    expect(p.draws).toBe(1);
    expect(p.slopePerYear).toBeNull();
    expect(p.trend).toBeNull();
    // A single draw yields no trend phrase — the card falls back to a "one
    // measurement" note.
    expect(paceOfAgingPhrase(p)).toBeNull();
  });

  it("two draws sharing a calendar day cannot form a slope", () => {
    const p = paceOfAging([
      { date: "2024-01-01", bioAge: 47, chronoAge: 50 },
      { date: "2024-01-01", bioAge: 49, chronoAge: 50 },
    ]);
    expect(p.status).toBe("single");
    expect(p.slopePerYear).toBeNull();
  });

  it("a widening gap over time (aging faster than the calendar)", () => {
    // Delta goes -3 → -1 → +1 over two years: the gap grows ~2 yr/yr faster than
    // the calendar even though chronological age climbs normally.
    const p = paceOfAging([
      { date: "2022-01-01", bioAge: 47, chronoAge: 50 },
      { date: "2023-01-01", bioAge: 50, chronoAge: 51 },
      { date: "2024-01-01", bioAge: 53, chronoAge: 52 },
    ]);
    expect(p.status).toBe("trend");
    expect(p.trend).toBe("widening");
    expect(p.slopePerYear!).toBeGreaterThan(0);
    expect(paceOfAgingPhrase(p)).toContain("widening");
  });

  it("a narrowing gap over time (aging slower than the calendar)", () => {
    const p = paceOfAging([
      { date: "2022-01-01", bioAge: 53, chronoAge: 50 },
      { date: "2023-01-01", bioAge: 53, chronoAge: 51 },
      { date: "2024-01-01", bioAge: 53, chronoAge: 52 },
    ]);
    expect(p.status).toBe("trend");
    expect(p.trend).toBe("narrowing");
    expect(p.slopePerYear!).toBeLessThan(0);
    expect(paceOfAgingPhrase(p)).toContain("narrowing");
  });

  it("a flat delta reads as stable", () => {
    // bioAge tracks chronoAge exactly: delta constant → slope ~0 → stable.
    const p = paceOfAging([
      { date: "2022-01-01", bioAge: 47, chronoAge: 50 },
      { date: "2023-01-01", bioAge: 48, chronoAge: 51 },
      { date: "2024-01-01", bioAge: 49, chronoAge: 52 },
    ]);
    expect(p.status).toBe("trend");
    expect(p.trend).toBe("stable");
    expect(paceOfAgingPhrase(p)).toContain("holding steady");
  });
});

describe("inputCompleteness", () => {
  it("complete when all nine inputs are present", () => {
    const c = inputCompleteness(PHENOAGE_INPUT_NAMES);
    expect(c.complete).toBe(true);
    expect(c.presentCount).toBe(9);
    expect(c.missing).toEqual([]);
    expect(completenessChecklistMessage(c)).toBe("All 9 inputs present.");
  });

  it("partial panel lists exactly the missing analytes (the import CTA)", () => {
    // Present seven of nine; missing hs-CRP and Albumin.
    const present = PHENOAGE_INPUT_NAMES.filter(
      (n) => n !== "hs-CRP" && n !== "Albumin"
    );
    const c = inputCompleteness(present);
    expect(c.complete).toBe(false);
    expect(c.presentCount).toBe(7);
    expect(c.missing).toEqual(
      PHENOAGE_INPUT_NAMES.filter((n) => n === "Albumin" || n === "hs-CRP")
    );
    const msg = completenessChecklistMessage(c);
    expect(msg).toContain("7 of 9 inputs present");
    expect(msg).toContain("add");
    expect(msg).toContain("hs-CRP");
    expect(msg).toContain("Albumin");
    expect(msg).toContain("to compute your biological age");
  });

  it("a single missing analyte uses no comma", () => {
    const present = PHENOAGE_INPUT_NAMES.filter((n) => n !== "RDW");
    const msg = completenessChecklistMessage(inputCompleteness(present));
    expect(msg).toBe(
      "8 of 9 inputs present; add RDW to compute your biological age."
    );
  });

  it("ignores unrelated analyte names", () => {
    const c = inputCompleteness(["Ferritin", "Vitamin D", "Testosterone"]);
    expect(c.presentCount).toBe(0);
    expect(c.complete).toBe(false);
  });
});

describe("isBioAgeHiddenForAge", () => {
  it("hides child profiles (known age below the adult floor)", () => {
    expect(isBioAgeHiddenForAge(1)).toBe(true);
    expect(isBioAgeHiddenForAge(17)).toBe(true);
  });

  it("shows adults", () => {
    expect(isBioAgeHiddenForAge(18)).toBe(false);
    expect(isBioAgeHiddenForAge(50)).toBe(false);
  });

  it("never hides on unknown age", () => {
    expect(isBioAgeHiddenForAge(null)).toBe(false);
  });
});
