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
  bioAgeDeltaCompact,
  bioAgeDeltaPhrase,
  paceOfAging,
  paceOfAgingPhrase,
  inputCompleteness,
  completenessChecklistMessage,
  bioAgeInputsStatus,
  bioAgeSurface,
  type BioAgePanel,
  isBioAgeHiddenForAge,
} from "../bio-age";
import { AGE_INPUT_KEY, type PhenoAgeInputEffect } from "../derived-biomarkers";
import { DEFAULT_FORMAT_PREFS } from "../format-date";
import canonicalSeed from "../canonical-result-definitions.json";
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

  it("normalizes a machine-spelled micro unit in the visible caveat", () => {
    const note = censoredInputNote({
      inputs: [{ name: "Selenium", value: 45, unit: "ug / L", bound: "<" }],
      censored: {
        inputs: [{ name: "Selenium", label: "Selenium", bound: "<" }],
        bias: null,
      },
    });
    expect(note).toContain("45 µg / L");
    expect(note).not.toContain("ug / L");
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

  it("compacts the delta for a value slot", () => {
    expect(bioAgeDeltaCompact(bioAgeDelta(46.8, 50))).toBe("3.2 yrs younger");
    expect(bioAgeDeltaCompact(bioAgeDelta(56, 55))).toBe("1 yr older");
    expect(bioAgeDeltaCompact(bioAgeDelta(50, 50))).toBe("≈ calendar age");
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

  // TWO OF THE NINE CANONICAL NAMES CARRY A COMMA — "Glucose, Fasting" and
  // "Lymphocytes, Relative" — and a CMP/CBC split that omits exactly those two is an
  // ordinary panel, not a corner case. Comma-joined, the sentence names four analytes
  // the reader cannot resolve.
  it("does not let a comma-bearing analyte name read as two", () => {
    const c = inputCompleteness(
      PHENOAGE_INPUT_NAMES.filter(
        (n) => n !== "Glucose, Fasting" && n !== "Lymphocytes, Relative"
      )
    );
    expect(c.missing).toEqual(["Glucose, Fasting", "Lymphocytes, Relative"]);
    const msg = completenessChecklistMessage(c);
    expect(msg).toContain("add Glucose, Fasting; and Lymphocytes, Relative to");
    expect(msg).not.toContain("Fasting and Lymphocytes");
  });

  it("steps the whole list up to semicolons, not just the joint", () => {
    const c = inputCompleteness(
      PHENOAGE_INPUT_NAMES.filter(
        (n) =>
          n !== "Albumin" &&
          n !== "Glucose, Fasting" &&
          n !== "Lymphocytes, Relative"
      )
    );
    expect(completenessChecklistMessage(c)).toContain(
      "add Albumin; Glucose, Fasting; and Lymphocytes, Relative to"
    );
  });

  it("leaves a comma-free list exactly as it was", () => {
    const c = inputCompleteness(
      PHENOAGE_INPUT_NAMES.filter(
        (n) =>
          n !== "Albumin" &&
          n !== "Creatinine" &&
          n !== "White Blood Cell Count"
      )
    );
    expect(completenessChecklistMessage(c)).toContain(
      "add Albumin, Creatinine, and White Blood Cell Count to"
    );
  });

  it("ignores unrelated analyte names", () => {
    const c = inputCompleteness(["Ferritin", "Vitamin D", "Testosterone"]);
    expect(c.presentCount).toBe(0);
    expect(c.complete).toBe(false);
  });
});

// ── The inputs card's status line (#3050) ────────────────────────────────────
//
// The card gathered the computed draws and rendered only their COUNT, so it never
// said WHICH draw the result behind its button was from, and its checklist ("any
// usable reading, ever") could read as complete while its own footnote's requirement
// (all nine FROM ONE DRAW) was unmet — nine ticks, "All 9 inputs present.", and a
// button onto a section that renders nothing.
//
// The sentences are asserted here in full rather than paraphrased: they are the fix.
describe("bioAgeInputsStatus", () => {
  const ALL_NINE = inputCompleteness(PHENOAGE_INPUT_NAMES);
  const CRP = "High-Sensitivity C-Reactive Protein (hs-CRP)";
  const panel = (date: string, missing: string[] = []): BioAgePanel => ({
    date,
    present: PHENOAGE_INPUT_NAMES.filter((n) => !missing.includes(n)),
    missing: PHENOAGE_INPUT_NAMES.filter((n) => missing.includes(n)),
  });

  it("names the draw the linked result is computed from", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2026-06-03")],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("computed");
    expect(s.message).toBe(
      "All 9 inputs present · computed from your Jun 3, 2026 draw."
    );
  });

  it("names the LATEST draw when several computed", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2021-04-20" }, { date: "2026-06-03" }],
      [panel("2021-04-20"), panel("2026-06-03")],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.message).toContain("Jun 3, 2026");
    expect(s.message).not.toContain("2021");
  });

  it("says nine present is NOT nine together when no draw carries them all", () => {
    // Albumin from an old draw, the other eight from a recent one: the checklist is
    // complete, the model has nothing to compute from, and /longevity renders no
    // section at all. The old sentence claimed a result existed.
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [],
      [
        panel(
          "2020-02-02",
          PHENOAGE_INPUT_NAMES.filter((n) => n !== "Albumin")
        ),
        panel("2026-06-03", ["Albumin"]),
      ],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("never-together");
    expect(s.message).toBe(
      "All 9 inputs present, but not from one draw — the model needs them together."
    );
    // It must not read as a result the reader can go and look at.
    expect(s.message).not.toContain("computed");
  });

  it("names the gap AND the still-live draw when a newer panel missed", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2026-06-03"), panel("2026-07-12", [CRP])],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("stale");
    expect(s.message).toBe(
      `Your Jul 12, 2026 panel is missing ${CRP} — your biological age is still from Jun 3, 2026.`
    );
  });

  it("names both gaps when a newer panel missed two", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2026-06-03"), panel("2026-07-12", [CRP, "Albumin"])],
      DEFAULT_FORMAT_PREFS
    );
    // In PHENOAGE_INPUT_NAMES order, like the checklist's own list.
    expect(s.message).toContain(`missing Albumin and ${CRP}`);
  });

  it("keeps a comma-bearing pair readable in the newer-panel sentence", () => {
    // The state this sentence exists for: a re-draw split across CMP and CBC that
    // came back without the two comma-bearing names. Beside two comma-bearing DATES,
    // a comma-joined pair here would read as four analytes.
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [
        panel("2026-06-03"),
        panel("2026-07-12", ["Glucose, Fasting", "Lymphocytes, Relative"]),
      ],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.message).toBe(
      "Your Jul 12, 2026 panel is missing Glucose, Fasting; and Lymphocytes, Relative — your biological age is still from Jun 3, 2026."
    );
  });

  it("stays quiet about a later day that is not a re-draw of the panel", () => {
    // A single glucose from a CGM export is not a panel that "missed" — reporting its
    // seven gaps on every such day would bury the card's one actionable line.
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2026-06-03"), panel("2026-08-12", PHENOAGE_INPUT_NAMES.slice(1))],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("computed");
    expect(s.message).toContain("Jun 3, 2026");
  });

  it("ignores an OLDER partial panel: the current draw still computed", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2021-04-20", [CRP]), panel("2026-06-03")],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("computed");
  });

  it("leaves the partial-panel CTA message exactly as it was", () => {
    const present = PHENOAGE_INPUT_NAMES.filter((n) => n !== CRP);
    const c = inputCompleteness(present);
    const s = bioAgeInputsStatus(
      c,
      [],
      [panel("2026-06-03", [CRP])],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.kind).toBe("partial");
    expect(s.message).toBe(completenessChecklistMessage(c));
  });

  it("claims nothing about a draw the document itself reported", () => {
    // A complete panel with no COMPUTED draw means a stored PhenoAge won that date.
    // The card has no claim to make about it, so it states the checklist and stops.
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [],
      [panel("2026-06-03")],
      DEFAULT_FORMAT_PREFS
    );
    expect(s.message).toBe("All 9 inputs present.");
  });

  it("renders its dates through the viewer's display prefs", () => {
    const s = bioAgeInputsStatus(
      ALL_NINE,
      [{ date: "2026-06-03" }],
      [panel("2026-06-03"), panel("2026-07-12", [CRP])],
      { ...DEFAULT_FORMAT_PREFS, dateFormat: "dmy" }
    );
    expect(s.message).toContain("12 Jul 2026");
    expect(s.message).toContain("3 Jun 2026");
  });

  it("states no estimate, in any state — the #2367 split (a date is not the number)", () => {
    const states = [
      bioAgeInputsStatus(
        ALL_NINE,
        [{ date: "2026-06-03" }],
        [panel("2026-06-03")],
        DEFAULT_FORMAT_PREFS
      ),
      bioAgeInputsStatus(
        ALL_NINE,
        [],
        [panel("2026-06-03", ["Albumin"])],
        DEFAULT_FORMAT_PREFS
      ),
      bioAgeInputsStatus(
        ALL_NINE,
        [{ date: "2026-06-03" }],
        [panel("2026-06-03"), panel("2026-07-12", [CRP])],
        DEFAULT_FORMAT_PREFS
      ),
    ];
    for (const s of states) {
      expect(s.message).not.toMatch(/biological age is \d/i);
      expect(s.message).not.toMatch(/years (younger|older)/i);
      expect(s.message).not.toMatch(/per year/i);
    }
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

  it("keeps the input checklist eligible on unknown age without exposing a number", () => {
    expect(isBioAgeHiddenForAge(null)).toBe(false);
    expect(bioAgeSurface(isBioAgeHiddenForAge(null), 0, 3)).toBe("checklist");
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
    const seed = (canonicalSeed as { definitions: { name: string }[] })
      .definitions;
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

  it("normalizes a machine-spelled micro unit in the row tooltip", () => {
    const phrase = bioAgeEffectPhrase(effect({ unit: "ug / L" }));
    expect(phrase).toContain("12.3 µg / L (optimal)");
    expect(phrase).not.toContain("ug / L");
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
