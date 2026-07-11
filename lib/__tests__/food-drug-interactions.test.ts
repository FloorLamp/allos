import { describe, expect, it } from "vitest";
import {
  matchFoodInteractions,
  foodGuidanceLine,
  foodGuidanceDetail,
  foodGuidanceReminderNote,
  SEVERITY_RANK,
} from "@/lib/food-drug-interactions";

// Pure food–drug guidance matching (issue #154). Synthetic item names only — no real
// PHI. Exercises: an rxcui-keyed match, a name-fallback match, a no-match, a
// multi-guidance item, severity ranking, and the informational (never prescriptive)
// formatters.

describe("matchFoodInteractions", () => {
  it("matches a statin by name (fallback) and returns the grapefruit guidance", () => {
    const hits = matchFoodInteractions({
      name: "Simvastatin 40mg",
      rxcui: null,
    });
    const grapefruit = hits.find((h) => h.key === "grapefruit-statin");
    expect(grapefruit).toBeTruthy();
    expect(grapefruit!.severity).toBe("major");
    expect(grapefruit!.advice.toLowerCase()).toContain("grapefruit");
    expect(grapefruit!.source.length).toBeGreaterThan(0);
  });

  it("matches a statin by its RxCUI even when the name is unhelpful", () => {
    // Gibberish name no synonym matches — the ingredient code carries the identity.
    const hits = matchFoodInteractions({
      name: "Generic tablet A",
      rxcui: "36567",
    });
    expect(hits.map((h) => h.key)).toContain("grapefruit-statin");
  });

  it("matches levothyroxine by its RxCUI (dairy/coffee/calcium guidance)", () => {
    const hits = matchFoodInteractions({
      name: "Brand X 88mcg",
      rxcui: "10582",
    });
    const levo = hits.find((h) => h.key === "dairy-levothyroxine");
    expect(levo).toBeTruthy();
    expect(levo!.advice).toContain("empty stomach");
  });

  it("returns nothing for an item with no known food interaction", () => {
    expect(
      matchFoodInteractions({ name: "Vitamin D3 2000 IU", rxcui: null })
    ).toHaveLength(0);
    expect(
      matchFoodInteractions({ name: "Creatine Monohydrate", rxcui: null })
    ).toHaveLength(0);
  });

  it("does word-boundary matching, not naive substring", () => {
    // "cipro" must not match inside an unrelated word.
    expect(
      matchFoodInteractions({ name: "Ciprofen blend", rxcui: null }).map(
        (h) => h.key
      )
    ).not.toContain("dairy-fluoroquinolone");
    expect(
      matchFoodInteractions({ name: "Cipro 500 mg", rxcui: null }).map(
        (h) => h.key
      )
    ).toContain("dairy-fluoroquinolone");
  });

  it("returns MULTIPLE guidance lines for a multi-interaction item (warfarin → vitamin K + alcohol)", () => {
    const hits = matchFoodInteractions({ name: "Warfarin", rxcui: "11289" });
    const keys = hits.map((h) => h.key);
    expect(keys).toContain("vitamin-k-warfarin");
    expect(keys).toContain("alcohol-warfarin");
    // No duplicate entry ids.
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ranks major before moderate before minor", () => {
    // Warfarin's two hits are both moderate; use an item mixing severities is not
    // available, so assert the ordering invariant holds across any item's hits.
    const hits = matchFoodInteractions({ name: "Metronidazole", rxcui: null });
    for (let i = 1; i < hits.length; i++) {
      expect(SEVERITY_RANK[hits[i - 1].severity]).toBeLessThanOrEqual(
        SEVERITY_RANK[hits[i].severity]
      );
    }
    // Metronidazole × alcohol is a MAJOR entry.
    expect(hits[0].severity).toBe("major");
  });

  it("matches a tetracycline by name-fallback (dairy/mineral chelation)", () => {
    const hits = matchFoodInteractions({
      name: "Doxycycline 100 mg",
      rxcui: null,
    });
    expect(hits.map((h) => h.key)).toContain("dairy-tetracycline");
  });
});

describe("formatting", () => {
  const hit = matchFoodInteractions({ name: "Simvastatin", rxcui: null }).find(
    (h) => h.key === "grapefruit-statin"
  )!;

  it("foodGuidanceLine is the actionable advice", () => {
    expect(foodGuidanceLine(hit)).toBe(hit.advice);
  });

  it("foodGuidanceDetail is informational, never prescriptive, and cites a source", () => {
    const detail = foodGuidanceDetail(hit);
    expect(detail).toContain("discuss with your prescriber or pharmacist");
    expect(detail).toContain("Source:");
    expect(detail.toLowerCase()).not.toContain("stop taking");
  });

  it("foodGuidanceReminderNote uses the top hit's advice, or null when empty", () => {
    expect(foodGuidanceReminderNote([])).toBeNull();
    const note = foodGuidanceReminderNote(
      matchFoodInteractions({ name: "Simvastatin", rxcui: null })
    );
    expect(note).toContain("⚠️");
    expect(note!.toLowerCase()).toContain("grapefruit");
  });
});

// Combination medications (issue #279): the food matcher shares the drug matcher's
// fix — try every cached ingredient CUI and know the distinct combo brand names.
describe("combination medications (issue #279)", () => {
  it("REGRESSION: a combo brand (Hyzaar) gets the salt-substitute guidance by name", () => {
    const hits = matchFoodInteractions({
      name: "Hyzaar 100-12.5",
      rxcui: null,
    });
    expect(hits.map((h) => h.key)).toContain("potassium-ace-arb");
  });

  it("matches through cached ingredient CUIs when the product rxcui is unknown", () => {
    // 52175 is losartan; "999999" stands in for a product-level code that appears
    // in no entry's ingredient list.
    const hits = matchFoodInteractions({
      name: "Generic combination tablet B",
      rxcui: "999999",
      rxcuiIngredients: ["52175", "5487"],
    });
    expect(hits.map((h) => h.key)).toContain("potassium-ace-arb");
  });

  it("a statin combo brand (Vytorin) gets the grapefruit guidance", () => {
    const hits = matchFoodInteractions({ name: "Vytorin 10/40", rxcui: null });
    const grapefruit = hits.find((h) => h.key === "grapefruit-statin");
    expect(grapefruit).toBeTruthy();
    expect(grapefruit!.severity).toBe("major");
  });
});
