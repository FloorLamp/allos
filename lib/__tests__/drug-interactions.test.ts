import { describe, expect, it } from "vitest";
import {
  detectInteractions,
  interactionsForCandidate,
  matchConceptKeys,
  interactionSignalKey,
  interactionTitle,
  interactionDetail,
  SEVERITY_RANK,
  type InteractionItem,
} from "@/lib/drug-interactions";

// Pure drug-/supplement-interaction detection (issue #144). Synthetic item pairs
// only — no real PHI. Exercises: a hit, a no-hit, a supplement-drug hit, rxcui-keyed
// vs name-fallback matching, inactive/paused exclusion, severity ranking, and the
// id-pair dedupeKey.

function item(
  id: number,
  name: string,
  opts: { rxcui?: string | null; active?: boolean } = {}
): InteractionItem {
  return {
    id,
    name,
    rxcui: opts.rxcui ?? null,
    active: opts.active ?? true,
  };
}

describe("matchConceptKeys", () => {
  it("matches an NSAID by name (fallback) even with no rxcui", () => {
    expect(
      matchConceptKeys({ name: "Ibuprofen 200mg", rxcui: null })
    ).toContain("nsaid");
  });

  it("matches warfarin by its RxCUI even when the name is unhelpful", () => {
    // A gibberish name that no synonym matches — the code carries the identity.
    expect(
      matchConceptKeys({ name: "Generic tablet A", rxcui: "11289" })
    ).toContain("warfarin");
  });

  it("does word-boundary matching, not naive substring", () => {
    // "iron" must not match inside "environmental".
    expect(
      matchConceptKeys({ name: "Environmental greens blend", rxcui: null })
    ).not.toContain("iron");
    expect(
      matchConceptKeys({ name: "Iron bisglycinate", rxcui: null })
    ).toContain("iron");
  });

  it("matches a multi-word supplement synonym (St. John's Wort)", () => {
    expect(
      matchConceptKeys({ name: "St. John's Wort 300 mg", rxcui: null })
    ).toContain("st_johns_wort");
  });
});

describe("detectInteractions", () => {
  it("flags warfarin + ibuprofen as a major interaction", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
    expect(hits[0].aId).toBe(1);
    expect(hits[0].bId).toBe(2);
    expect(hits[0].dedupeKey).toBe("interaction:1-2");
    expect(hits[0].mechanism.length).toBeGreaterThan(0);
    expect(hits[0].source.length).toBeGreaterThan(0);
  });

  it("returns no hit for a non-interacting pair", () => {
    const hits = detectInteractions([
      item(1, "Vitamin D3"),
      item(2, "Creatine Monohydrate"),
    ]);
    expect(hits).toHaveLength(0);
  });

  it("detects a supplement-drug interaction (St. John's Wort + an SSRI)", () => {
    const hits = detectInteractions([
      item(1, "Sertraline"),
      item(2, "St. John's Wort"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("matches by name-fallback when no rxcui is set", () => {
    // Neither item carries a code — both resolve by name (warfarin, nsaid).
    const hits = detectInteractions([item(1, "Warfarin"), item(2, "Naproxen")]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("excludes inactive/paused items from detection", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen", { active: false }),
    ]);
    expect(hits).toHaveLength(0);
  });

  it("dedupes to one hit per item pair, keeping the most severe rule", () => {
    // Levothyroxine + calcium is one pair; only one finding, and calcium+iron
    // adds a separate pair.
    const hits = detectInteractions([
      item(1, "Levothyroxine"),
      item(2, "Calcium carbonate"),
      item(3, "Ferrous sulfate"),
    ]);
    // levo+calcium, levo+iron, calcium+iron → 3 distinct pairs.
    const keys = hits.map((h) => h.dedupeKey).sort();
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("interaction:1-2");
    expect(keys).toContain("interaction:1-3");
    expect(keys).toContain("interaction:2-3");
  });

  it("ranks major before moderate before minor", () => {
    const hits = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"), // major with warfarin
      item(3, "Fish oil"), // moderate with warfarin
    ]);
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // First hit is the most severe.
    for (let i = 1; i < hits.length; i++) {
      expect(SEVERITY_RANK[hits[i - 1].severity]).toBeLessThanOrEqual(
        SEVERITY_RANK[hits[i].severity]
      );
    }
  });

  it("does not pair an item with itself", () => {
    const hits = detectInteractions([item(1, "Ibuprofen")]);
    expect(hits).toHaveLength(0);
  });
});

describe("interactionsForCandidate", () => {
  const stack: InteractionItem[] = [
    item(1, "Warfarin", { rxcui: "11289" }),
    item(2, "Vitamin D3"),
  ];

  it("flags a new item that interacts with the existing stack", () => {
    const hits = interactionsForCandidate(
      { name: "Ibuprofen", rxcui: null },
      stack
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("major");
  });

  it("returns nothing for a new item that doesn't interact", () => {
    const hits = interactionsForCandidate(
      { name: "Magnesium glycinate", rxcui: null },
      stack
    );
    expect(hits).toHaveLength(0);
  });

  it("does not pair the candidate with the row it is editing (same id excluded upstream)", () => {
    // The candidate is id 0; a stack that includes a stale copy at id 0 is filtered.
    const hits = interactionsForCandidate(
      { name: "Warfarin", rxcui: "11289" },
      [item(0, "Warfarin", { rxcui: "11289" }), item(2, "Vitamin D3")]
    );
    expect(hits).toHaveLength(0);
  });
});

describe("formatting + keys", () => {
  it("interactionSignalKey is direction-independent", () => {
    expect(interactionSignalKey(5, 2)).toBe("interaction:2-5");
    expect(interactionSignalKey(2, 5)).toBe("interaction:2-5");
  });

  it("interactionTitle joins the two names", () => {
    const hit = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ])[0];
    expect(interactionTitle(hit)).toBe("Warfarin + Ibuprofen");
  });

  it("interactionDetail is informational, never prescriptive", () => {
    const hit = detectInteractions([
      item(1, "Warfarin", { rxcui: "11289" }),
      item(2, "Ibuprofen"),
    ])[0];
    const detail = interactionDetail(hit);
    expect(detail).toContain("discuss with your prescriber");
    expect(detail.toLowerCase()).not.toContain("stop taking");
  });
});

// Combination medications (issue #279): a combo product's single product-level
// rxcui can't match the ingredient-only concept CUIs, so matching must also try
// the cached ingredient CUIs — and a distinct combo BRAND name (Hyzaar, Glucovance)
// must resolve through the synonym vocabulary. All names/codes synthetic or
// public-domain RxNorm vocabulary — no PHI.
describe("combination medications (issue #279)", () => {
  it("matches a combo product through its cached ingredient CUIs when the product rxcui is unknown", () => {
    // "999999" stands in for a product-level SCD/SBD code that appears in no
    // concept's ingredient list; 52175 is losartan (an ARB ingredient).
    expect(
      matchConceptKeys({
        name: "Generic combination tablet B",
        rxcui: "999999",
        rxcuiIngredients: ["52175", "5487"],
      })
    ).toContain("ace_arb");
  });

  it("matches a single-ingredient PRODUCT-level pick through its one ingredient CUI", () => {
    // The same mechanism fixes a non-combo product-level rxcui (e.g. an SCD like
    // "lisinopril 10 MG Oral Tablet") whose code is not ingredient-level either.
    expect(
      matchConceptKeys({
        name: "Generic tablet C",
        rxcui: "999998",
        rxcuiIngredients: ["29046"],
      })
    ).toContain("ace_arb");
  });

  it("matches a combination BRAND name via the synonym fallback (no rxcui at all)", () => {
    expect(
      matchConceptKeys({ name: "Hyzaar 100-12.5", rxcui: null })
    ).toContain("ace_arb");
    expect(
      matchConceptKeys({ name: "Zestoretic 20/25", rxcui: null })
    ).toContain("ace_arb");
  });

  it("maps a combo brand to EVERY member concept (Glucovance → metformin + sulfonylurea)", () => {
    const keys = matchConceptKeys({ name: "Glucovance", rxcui: null });
    expect(keys).toContain("metformin");
    expect(keys).toContain("sulfonylurea");
  });

  it("a slash-joined generic combo name already matches through its ingredient tokens", () => {
    // The normalizer collapses punctuation, so each ingredient is a word-boundary
    // token — pinned here so the tokenizer behavior can't regress.
    expect(
      matchConceptKeys({
        name: "Losartan/Hydrochlorothiazide 100-25",
        rxcui: null,
      })
    ).toContain("ace_arb");
  });

  it("REGRESSION: Hyzaar + Klor-Con flags the ace_arb × potassium hyperkalemia interaction", () => {
    // The issue's concrete false negative: losartan/HCTZ (combo brand) plus
    // potassium chloride. Must surface the moderate hyperkalemia-risk rule.
    const hits = detectInteractions([
      item(1, "Hyzaar 100-12.5"),
      item(2, "Klor-Con 10 mEq"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("moderate");
    expect(hits[0].mechanism.toLowerCase()).toContain("potassium");
    expect(hits[0].dedupeKey).toBe("interaction:1-2");
  });

  it("REGRESSION: the same pair flags via cached ingredient CUIs with an unhelpful name", () => {
    const hits = detectInteractions([
      {
        id: 1,
        name: "Combination tablet B",
        rxcui: "999999",
        rxcuiIngredients: ["52175", "5487"],
        active: true,
      },
      item(2, "Klor-Con 10 mEq"),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("moderate");
  });

  it("interactionsForCandidate sees a combo candidate's ingredients (inline form notice)", () => {
    const hits = interactionsForCandidate(
      {
        name: "Combination tablet B",
        rxcui: "999999",
        rxcuiIngredients: ["52175"],
      },
      [item(7, "Klor-Con 10 mEq")]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].bId === 7 || hits[0].aId === 7).toBe(true);
  });
});
