import { describe, it, expect } from "vitest";
import {
  bioAgeEffectLabel,
  bioAgeEffectPhrase,
  isBioAgeAgeInput,
  phenoAgeReferenceBasisLabel,
  phenoAgeReferenceValue,
  PHENOAGE_INPUT_NAMES,
  PHENOAGE_INPUT_ACCEPTED_NAMES,
  PHENOAGE_INPUT_COUNT,
  censoredInputNote,
  bioAgeDelta,
  bioAgeDeltaPhrase,
  paceOfAging,
  paceOfAgingPhrase,
  inputCompleteness,
  completenessChecklistMessage,
  isBioAgeHiddenForAge,
} from "../bio-age";
import { AGE_INPUT_KEY, type PhenoAgeInputEffect } from "../derived-biomarkers";
import canonicalSeed from "../canonical-biomarkers.json";
import type { CanonicalResultDefinition } from "../types";

describe("PhenoAge input catalogue", () => {
  it("carries the nine analytes the formula consumes", () => {
    expect(PHENOAGE_INPUT_COUNT).toBe(9);
    expect(PHENOAGE_INPUT_NAMES).toHaveLength(9);
    // A couple of anchors so the checklist wording stays grounded in real names.
    expect(PHENOAGE_INPUT_NAMES).toContain("Albumin");
    expect(PHENOAGE_INPUT_NAMES).toContain(
      "High-Sensitivity C-Reactive Protein (hs-CRP)"
    );
  });

  it("asks for glucose ONCE, under the fasting name the formula prefers (#2334)", () => {
    // The checklist is a list of things to go and get: an input that accepts two
    // spellings is still ONE thing, and PhenoAge is defined on fasting glucose.
    expect(PHENOAGE_INPUT_NAMES).toContain("Glucose, Fasting");
    expect(PHENOAGE_INPUT_NAMES).not.toContain("Glucose");
    // The accepted set is the wider one — a stored plain "Glucose" IS a bio-age
    // input for surfaces asking about an arbitrary analyte name.
    expect(PHENOAGE_INPUT_ACCEPTED_NAMES).toContain("Glucose");
    expect(PHENOAGE_INPUT_ACCEPTED_NAMES).toContain("Glucose, Fasting");
  });
});

// A single "biological age" number has no hollow dot to draw, so a censored input has
// to be said in words (#2334).
describe("censoredInputNote", () => {
  const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";
  const exactInputs = [
    { name: "Albumin", value: 4.4, unit: "g/dL" },
    { name: CRP, value: 0.2, unit: "mg/L" },
  ];

  it("is null when every component was an exact number", () => {
    expect(censoredInputNote({ inputs: exactInputs })).toBeNull();
  });

  it("names the input, its limit, and the direction of the bias", () => {
    const note = censoredInputNote({
      inputs: [
        exactInputs[0],
        { name: CRP, value: 0.2, unit: "mg/L", bound: "<" },
      ],
      censored: {
        inputs: [{ name: CRP, label: "CRP", bound: "<" }],
        bias: "over",
      },
    });
    expect(note).toBe(
      `Rests on a censored input: ${CRP} was reported below its detection limit and substituted at 0.2 mg/L. The estimate can only be too high from that substitution.`
    );
  });

  it("says an above-limit reading is above, and an under-estimate is under", () => {
    const note = censoredInputNote({
      inputs: [{ name: "Albumin", value: 5.5, unit: "g/dL", bound: ">" }],
      censored: {
        inputs: [{ name: "Albumin", label: "Alb", bound: ">" }],
        bias: "under",
      },
    });
    expect(note).toContain("reported above its detection limit");
    expect(note).toContain("can only be too low");
  });

  it("makes NO directional claim when the index declared none", () => {
    const note = censoredInputNote({
      inputs: [{ name: CRP, value: 0.2, unit: "mg/L", bound: "<" }],
      censored: {
        inputs: [{ name: CRP, label: "CRP", bound: "<" }],
        bias: null,
      },
    });
    expect(note).toContain("Rests on a censored input");
    expect(note).not.toContain("can only be");
  });

  it("lists several censored inputs in one sentence", () => {
    const note = censoredInputNote({
      inputs: [
        { name: "Albumin", value: 2, unit: "g/dL", bound: "<" },
        { name: CRP, value: 0.2, unit: "mg/L", bound: "<" },
      ],
      censored: {
        inputs: [
          { name: "Albumin", label: "Alb", bound: "<" },
          { name: CRP, label: "CRP", bound: "<" },
        ],
        bias: null,
      },
    });
    expect(note).toContain("Rests on censored inputs");
    expect(note).toContain("Albumin");
    expect(note).toContain(CRP);
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

  it("even when the rounded-sm gap is zero", () => {
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
      (n) =>
        n !== "High-Sensitivity C-Reactive Protein (hs-CRP)" && n !== "Albumin"
    );
    const c = inputCompleteness(present);
    expect(c.complete).toBe(false);
    expect(c.presentCount).toBe(7);
    expect(c.missing).toEqual(
      PHENOAGE_INPUT_NAMES.filter(
        (n) =>
          n === "Albumin" ||
          n === "High-Sensitivity C-Reactive Protein (hs-CRP)"
      )
    );
    const msg = completenessChecklistMessage(c);
    expect(msg).toContain("7 of 9 inputs present");
    expect(msg).toContain("add");
    expect(msg).toContain("High-Sensitivity C-Reactive Protein (hs-CRP)");
    expect(msg).toContain("Albumin");
    expect(msg).toContain("to compute your biological age");
  });

  it("a single missing analyte uses no comma", () => {
    const present = PHENOAGE_INPUT_NAMES.filter(
      (n) => n !== "Red Cell Distribution Width (RDW)"
    );
    const msg = completenessChecklistMessage(inputCompleteness(present));
    expect(msg).toBe(
      "8 of 9 inputs present; add Red Cell Distribution Width (RDW) to compute your biological age."
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

// ── What each input is compared against (#2366) ──────────────────────────────
//
// The counterfactual itself is arithmetic on the model (lib/derived-biomarkers); the
// decision tested here is WHICH value it moves an input to, and whether the copy can
// be read as a claim about the person rather than about the model.
describe("phenoAgeReferenceValue", () => {
  // Only the band fields matter; the rest of a curated entry is irrelevant here.
  function entry(
    over: Partial<CanonicalResultDefinition>
  ): CanonicalResultDefinition {
    return { name: "X", category: "lab", ...over } as CanonicalResultDefinition;
  }

  it("takes the OPTIMAL band's midpoint when the entry curates one", () => {
    const r = phenoAgeReferenceValue(
      entry({ optimal_low: 4.4, optimal_high: 5, ref_low: 3.5, ref_high: 5 }),
      "male",
      45,
      null
    );
    // The optimal band wins over the (wider) reference band it sits inside.
    expect(r).toEqual({ value: 4.7, basis: "optimal" });
  });

  it("falls back to the REFERENCE band's midpoint when no optimal band exists", () => {
    const r = phenoAgeReferenceValue(
      entry({ ref_low: 40, ref_high: 129 }),
      "male",
      45,
      null
    );
    expect(r).toEqual({ value: 84.5, basis: "reference" });
  });

  it("uses a ONE-SIDED band's stated bound — a half-open band has no midpoint", () => {
    // hs-CRP's shape: curated as "optimal ≤1 mg/L" with no lower edge and no reference
    // floor. Averaging it against a lower bound that does not exist would invent one.
    const r = phenoAgeReferenceValue(
      entry({ optimal_high: 1, ref_high: 3 }),
      "male",
      45,
      null
    );
    expect(r).toEqual({ value: 1, basis: "optimal" });
  });

  it("closes a one-sided OPTIMAL band with the reference band's other edge", () => {
    // RDW: optimal ≤13, reference 11.5–14.5. The pair that applies is 11.5–13.
    const r = phenoAgeReferenceValue(
      entry({ optimal_high: 13, ref_low: 11.5, ref_high: 14.5 }),
      "male",
      45,
      null
    );
    expect(r).toEqual({ value: 12.25, basis: "optimal" });
  });

  it("returns NULL for an entry with no band at all", () => {
    // The unqualified "Glucose" (#2337): band-less on purpose, because a draw that
    // never said whether the patient fasted cannot be judged. No target is invented.
    expect(phenoAgeReferenceValue(entry({}), "male", 45, null)).toBeNull();
    expect(phenoAgeReferenceValue(null, "male", 45, null)).toBeNull();
  });

  it("resolves the band that applies to THIS profile's age and sex", () => {
    const cb = entry({
      ref_low: 40,
      ref_high: 129,
      ranges_by_age: [{ min_age: 0, max_age: 19, ref_low: 45, ref_high: 155 }],
    });
    expect(phenoAgeReferenceValue(cb, "male", 45, null)?.value).toBe(84.5);
    expect(phenoAgeReferenceValue(cb, "male", 15, null)?.value).toBe(100);
  });

  it("answers for every curated PhenoAge input except the band-less glucose", () => {
    // The seed JSON carries the curated FIELDS; the stored-row columns (source,
    // created_at) are added at seed time and are irrelevant to a band lookup.
    const seed = (canonicalSeed as { biomarkers: { name: string }[] })
      .biomarkers;
    const byName = new Map(
      seed.map((b) => [b.name, b as Partial<CanonicalResultDefinition>])
    );
    for (const name of PHENOAGE_INPUT_ACCEPTED_NAMES) {
      const cb = byName.get(name);
      expect(cb, name).toBeDefined();
      const r = phenoAgeReferenceValue(
        cb as CanonicalResultDefinition,
        "male",
        45,
        null
      );
      if (name === "Glucose") expect(r, name).toBeNull();
      else expect(r, name).not.toBeNull();
    }
  });
});

describe("bio-age effect copy", () => {
  function effect(
    over: Partial<PhenoAgeInputEffect> = {}
  ): PhenoAgeInputEffect {
    return {
      key: "Red Cell Distribution Width (RDW)",
      name: "Red Cell Distribution Width (RDW)",
      label: "RDW",
      value: 14.2,
      unit: "%",
      reference: { value: 12.25, basis: "optimal" },
      effectYears: 1.4,
      ...over,
    };
  }

  it("signs the years and never writes a bare hyphen for a negative", () => {
    expect(bioAgeEffectLabel(effect())).toBe("+1.4 yr");
    expect(bioAgeEffectLabel(effect({ effectYears: -0.6 }))).toBe("−0.6 yr");
    expect(bioAgeEffectLabel(effect({ effectYears: 0 }))).toBe("±0.0 yr");
    expect(bioAgeEffectLabel(effect({ effectYears: null }))).toBeNull();
  });

  it("describes the MODEL, not the person — never advice, never a prediction", () => {
    const phrase = bioAgeEffectPhrase(effect());
    expect(phrase).toContain("The model reads 1.4 years higher");
    expect(phrase).toContain("12.3 % (optimal)");
    // The claim is about what the index would read, not about what would happen to
    // the reader if the analyte changed (see the attention doctrine).
    expect(phrase).not.toMatch(/you (could|would|should)|lower your|improve/i);
  });

  it("says an absent reference is NOT a zero effect", () => {
    const phrase = bioAgeEffectPhrase(
      effect({ name: "Glucose", reference: null, effectYears: null })
    );
    expect(phrase).toContain("no comparison");
    expect(phrase).toContain("not a zero effect");
  });

  it("says a comparison resting on a censored value rests on the limit", () => {
    const phrase = bioAgeEffectPhrase(
      effect({ label: "CRP", bound: "<", value: 0.2 })
    );
    expect(phrase).toContain("detection limit");
    expect(phrase).toContain("substituted limit");
  });

  it("names the basis of the reference so the target is checkable", () => {
    expect(phenoAgeReferenceBasisLabel({ value: 1, basis: "optimal" })).toBe(
      "optimal"
    );
    expect(phenoAgeReferenceBasisLabel({ value: 1, basis: "reference" })).toBe(
      "reference"
    );
    // The age row's reference is the model's own floor — stated as such rather than
    // dressed up as an "optimal age", which does not exist.
    expect(
      phenoAgeReferenceBasisLabel({ value: 18, basis: "model-floor" })
    ).toBe("youngest modelled age");
  });

  it("marks the chronological-age row, which links to no analyte series", () => {
    expect(isBioAgeAgeInput(effect({ key: AGE_INPUT_KEY }))).toBe(true);
    expect(isBioAgeAgeInput(effect())).toBe(false);
  });
});
