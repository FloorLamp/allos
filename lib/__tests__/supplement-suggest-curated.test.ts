import { describe, it, expect } from "vitest";
import {
  suggestCuratedSupplements,
  curatedSupplementBiomarkers,
  isCuratedSupplementBiomarker,
  type CuratedSupplementInput,
} from "@/lib/supplement-suggest-curated";

// Pure-tier tests for the DETERMINISTIC biomarker→supplement engine (issue #2378). No
// DB, no network, NO MODEL — the DB gather (getCuratedSupplementSuggestions) is
// exercised in the DB-tier test.

function baseInput(
  over: Partial<CuratedSupplementInput> = {}
): CuratedSupplementInput {
  return {
    flagged: [],
    allergens: [],
    medications: [],
    conditions: [],
    situations: [],
    ...over,
  };
}

const LOW_VITD = [{ name: "Vitamin D, 25-Hydroxy", flag: "low" }];
const LOW_OMEGA = [{ name: "Omega-3 Total (OmegaCheck)", flag: "low" }];

describe("coverage — what the curated map answers and what falls through", () => {
  it("answers a covered family that reads low", () => {
    const out = suggestCuratedSupplements(baseInput({ flagged: LOW_VITD }));
    expect(out.map((s) => s.key)).toEqual(["vitamin-d"]);
    expect(out[0].label).toBe("Vitamin D");
    expect(out[0].triggeredBy).toEqual(["Vitamin D, 25-Hydroxy"]);
    expect(out[0].supplements[0].name).toMatch(/cholecalciferol/i);
  });

  it("stays SILENT for a family the map does not cover — that is the AI route's job", () => {
    // Zinc is deliberately excluded from the map (poor status marker, copper
    // antagonism); a low zinc must produce nothing here rather than a guess.
    const out = suggestCuratedSupplements(
      baseInput({ flagged: [{ name: "Zinc", flag: "low" }] })
    );
    expect(out).toEqual([]);
    expect(isCuratedSupplementBiomarker("Zinc")).toBe(false);
  });

  it("triggers iron on FERRITIN only — a low serum Iron is not a status finding", () => {
    // Serum iron swings through the day, falls in inflammation, and rises after one
    // iron-containing meal; ferritin is the status marker. The one substance here with a
    // real overdose risk does not fire off the weakest reading in the map.
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged: [{ name: "Iron", flag: "low" }] })
      )
    ).toEqual([]);
    expect(isCuratedSupplementBiomarker("Iron")).toBe(false);
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged: [{ name: "Ferritin", flag: "low" }] })
      ).map((s) => s.key)
    ).toEqual(["iron"]);
  });

  it("only answers the LOW side — a high reading is a different question", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: [{ name: "Ferritin", flag: "high" }] })
    );
    expect(out).toEqual([]);
  });

  it("accepts non-optimal-low as low-side, like the food engine", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: [{ name: "Folate", flag: "non-optimal-low" }] })
    );
    expect(out.map((s) => s.key)).toEqual(["folate"]);
  });

  it("collapses several flagged members of one family into ONE suggestion (#482)", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [
          { name: "Omega-3 EPA", flag: "low" },
          { name: "Omega-3 DHA", flag: "low" },
        ],
      })
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("omega-3");
    expect(out[0].triggeredBy).toEqual(["Omega-3 EPA", "Omega-3 DHA"]);
  });

  it("reports its coverage as canonical biomarker names", () => {
    const names = curatedSupplementBiomarkers();
    expect(names).toContain("Vitamin D, 25-Hydroxy");
    expect(names).toContain("Ferritin");
    expect(isCuratedSupplementBiomarker("vitamin d, 25-hydroxy")).toBe(true);
    expect(isCuratedSupplementBiomarker("")).toBe(false);
  });
});

describe("determinism — the entire point of the curated half", () => {
  it("yields IDENTICAL output on repeated runs, with no model call", () => {
    const input = baseInput({
      flagged: [
        { name: "Vitamin D, 25-Hydroxy", flag: "low" },
        { name: "Ferritin", flag: "low" },
        { name: "Omega-3 EPA", flag: "low" },
      ],
      allergens: ["fish"],
      medications: [
        { name: "Levothyroxine", rxcui: "10582", rxcuiIngredients: null },
      ],
      conditions: [{ name: "Chronic kidney disease stage 3" }],
    });
    const runs = Array.from({ length: 5 }, () =>
      JSON.stringify(suggestCuratedSupplements(input))
    );
    expect(new Set(runs).size).toBe(1);
    // …and it is genuinely producing something, not trivially stable on nothing.
    expect(JSON.parse(runs[0]).length).toBeGreaterThan(0);
  });
});

describe("the allergy screen — struck, with the curated alternative surfacing", () => {
  it("strikes fish oil for a fish allergy and offers algal oil instead", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, allergens: ["fish"] })
    );
    expect(out).toHaveLength(1);
    expect(out[0].supplements).toHaveLength(1);
    expect(out[0].supplements[0].name).toMatch(/algal/i);
    expect(out[0].supplements[0].isAlternative).toBe(true);
    expect(out[0].safetyNotes.some((n) => n.kind === "allergy")).toBe(true);
  });

  it("strikes fish oil by CROSS-REACTIVITY too (a shellfish allergy)", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, allergens: ["shrimp"] })
    );
    expect(out[0].supplements[0].isAlternative).toBe(true);
  });

  it("withholds the whole suggestion when even the alternative is struck", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, allergens: ["fish", "algal oil"] })
    );
    expect(out).toEqual([]);
  });

  it("leaves an unrelated allergy alone", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, allergens: ["penicillin"] })
    );
    expect(out[0].supplements[0].isAlternative).toBe(false);
  });
});

describe("the condition screens — reused, not reimplemented", () => {
  it("hard-drops magnesium for CKD through the SHARED condition→nutrient rule", () => {
    // The magnesium entry declares NO CKD tag of its own: CONDITION_NUTRIENT_RULES
    // (derived from the food map) carries it, and screenSuggestionSafety applies it.
    const flagged = [{ name: "Magnesium", flag: "low" }];
    expect(
      suggestCuratedSupplements(baseInput({ flagged })).map((s) => s.key)
    ).toEqual(["magnesium"]);
    const withCkd = suggestCuratedSupplements(
      baseInput({ flagged, conditions: [{ name: "Chronic kidney disease" }] })
    );
    expect(withCkd).toEqual([]);
  });

  it("hard-drops iron for haemochromatosis via the map's own drop tag", () => {
    const flagged = [{ name: "Ferritin", flag: "low" }];
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged, conditions: [{ name: "Hemochromatosis" }] })
      )
    ).toEqual([]);
    // …and the British spelling, which the same single match term covers.
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged, conditions: [{ name: "Haemochromatosis" }] })
      )
    ).toEqual([]);
  });

  it("hard-drops vitamin D for sarcoidosis and annotates it for CKD", () => {
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged: LOW_VITD, conditions: [{ name: "Sarcoidosis" }] })
      )
    ).toEqual([]);
    const ckd = suggestCuratedSupplements(
      baseInput({
        flagged: LOW_VITD,
        conditions: [{ name: "Chronic kidney disease stage 3" }],
      })
    );
    expect(ckd).toHaveLength(1);
    expect(ckd[0].safetyNotes.some((n) => n.kind === "condition")).toBe(true);
  });

  it("annotates from an active SITUATION as well as a condition", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, situations: ["Pregnancy"] })
    );
    expect(out).toHaveLength(1);
    expect(
      out[0].safetyNotes.filter((n) => n.kind === "condition")
    ).toHaveLength(1);
  });
});

describe("the medication screens — the same shared machinery", () => {
  it("attaches the curated separation-window advice for a matching stack drug", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [{ name: "Ferritin", flag: "low" }],
        medications: [
          { name: "Levothyroxine", rxcui: "10582", rxcuiIngredients: null },
        ],
      })
    );
    expect(out).toHaveLength(1);
    const med = out[0].safetyNotes.filter((n) => n.kind === "medication");
    expect(med).toHaveLength(1);
    expect(med[0].text).toMatch(/hours apart|≥4 hours|absorption/i);
    // A timing note NEVER drops the suggestion — the iron still shows.
    expect(out[0].supplements).toHaveLength(1);
  });

  it("warns a profile on a blood thinner about supplemental omega-3, and only that profile", () => {
    // The bleeding-time caution is TARGETED, not generic small print in the caveat: it
    // fires off the stack, through the same curated food–drug index.
    const bare = suggestCuratedSupplements(baseInput({ flagged: LOW_OMEGA }));
    expect(bare[0].safetyNotes.filter((n) => n.kind === "medication")).toEqual(
      []
    );

    for (const med of [
      { name: "Warfarin", rxcui: "11289", rxcuiIngredients: null },
      { name: "Eliquis", rxcui: null, rxcuiIngredients: null },
      { name: "Clopidogrel", rxcui: "32968", rxcuiIngredients: null },
    ]) {
      const out = suggestCuratedSupplements(
        baseInput({ flagged: LOW_OMEGA, medications: [med] })
      );
      const notes = out[0].safetyNotes.filter((n) => n.kind === "medication");
      expect(notes.map((n) => n.text).join(" "), med.name).toMatch(
        /bleeding time/i
      );
    }
  });

  it("keeps that warning on the ALGAL alternative — same EPA/DHA, same caution", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: LOW_OMEGA,
        allergens: ["fish"],
        medications: [
          { name: "Warfarin", rxcui: "11289", rxcuiIngredients: null },
        ],
      })
    );
    expect(out[0].supplements[0].isAlternative).toBe(true);
    expect(
      out[0].safetyNotes.filter((n) => n.kind === "medication")
    ).toHaveLength(1);
  });

  it("attaches the levothyroxine separation window to magnesium as well as iron", () => {
    for (const bm of ["Magnesium", "Ferritin"]) {
      const out = suggestCuratedSupplements(
        baseInput({
          flagged: [{ name: bm, flag: "low" }],
          medications: [
            { name: "Levothyroxine", rxcui: "10582", rxcuiIngredients: null },
          ],
        })
      );
      const notes = out[0].safetyNotes.filter((n) => n.kind === "medication");
      expect(notes, bm).toHaveLength(1);
      expect(notes[0].text, bm).toMatch(/empty stomach/i);
    }
  });

  it("attaches nothing when the stack has no matching drug", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [{ name: "Ferritin", flag: "low" }],
        medications: [
          { name: "Amoxicillin", rxcui: null, rxcuiIngredients: null },
        ],
      })
    );
    expect(out[0].safetyNotes).toEqual([]);
  });
});

describe("the already-in-your-stack screen", () => {
  it("says nothing about a substance the profile already takes", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_VITD, alreadyTaking: ["Vitamin D3 5000"] })
    );
    expect(out).toEqual([]);
  });

  it("matches on the curated ALTERNATIVE too (algal oil covers omega-3)", () => {
    const out = suggestCuratedSupplements(
      baseInput({ flagged: LOW_OMEGA, alreadyTaking: ["Algal oil"] })
    );
    expect(out).toEqual([]);
  });

  it("does not match a merely similar name (word-boundary tokens)", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [{ name: "Ferritin", flag: "low" }],
        alreadyTaking: ["Ironman electrolyte mix"],
      })
    );
    expect(out).toHaveLength(1);
  });
});

describe("framing", () => {
  it("marks every suggestion as curated and carries its evidence + source", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [
          { name: "Vitamin D, 25-Hydroxy", flag: "low" },
          { name: "Vitamin B12", flag: "low" },
          { name: "Folate", flag: "low" },
        ],
      })
    );
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.origin).toBe("curated");
      expect(s.evidence.trim().length).toBeGreaterThan(0);
      expect(s.source.trim().length).toBeGreaterThan(0);
      expect(s.supplements.length).toBeGreaterThan(0);
    }
  });

  it("never emits a dose — there is no field for one and no text carrying one", () => {
    const out = suggestCuratedSupplements(
      baseInput({
        flagged: [
          { name: "Vitamin D, 25-Hydroxy", flag: "low" },
          { name: "Ferritin", flag: "low" },
          { name: "Magnesium", flag: "low" },
          { name: "Omega-3 EPA", flag: "low" },
        ],
      })
    );
    const DOSE = /\b\d[\d.,]*\s*(mg|mcg|µg|ug|g|iu|ml)\b/i;
    for (const s of out) {
      for (const item of s.supplements) {
        expect(item).not.toHaveProperty("dosage");
        expect(DOSE.test(`${item.name} ${item.note ?? ""}`)).toBe(false);
      }
      expect(DOSE.test(`${s.evidence} ${s.caveat ?? ""}`)).toBe(false);
    }
  });

  it("returns nothing at all when nothing is flagged low", () => {
    expect(suggestCuratedSupplements(baseInput())).toEqual([]);
    expect(
      suggestCuratedSupplements(
        baseInput({ flagged: [{ name: "Vitamin D, 25-Hydroxy", flag: null }] })
      )
    ).toEqual([]);
  });
});
