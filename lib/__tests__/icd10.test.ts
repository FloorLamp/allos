import { describe, expect, it } from "vitest";
import {
  suggestIcd10,
  bestIcd10Suggestion,
  conditionCollapseKey,
  ICD10_SYSTEM,
} from "@/lib/icd10";

// Pure tests for the ICD-10-CM suggestion + the condition de-dup collapse key (#155).
// No DB/network — exercises the fuzzy name→code lookup and the code-beats-name rule.

describe("suggestIcd10", () => {
  it("returns nothing for a too-short or blank query", () => {
    expect(suggestIcd10("")).toEqual([]);
    expect(suggestIcd10("  ")).toEqual([]);
    expect(suggestIcd10("mi")).toEqual([]); // 2 chars — too ambiguous
  });

  it("returns nothing for a name that matches no curated condition", () => {
    expect(suggestIcd10("quantum flux capacitor")).toEqual([]);
  });

  it("suggests the exact code for a canonical name", () => {
    expect(bestIcd10Suggestion("Unspecified asthma, uncomplicated")?.code).toBe(
      "J45.909"
    );
  });

  it("matches a lay-term synonym, not just the clinical name", () => {
    // "high blood pressure" is a synonym of I10 (name: Essential (primary) hypertension).
    expect(bestIcd10Suggestion("high blood pressure")?.code).toBe("I10");
    expect(bestIcd10Suggestion("acid reflux")?.code).toBe("K21.9");
    expect(bestIcd10Suggestion("type 2 diabetes")?.code).toBe("E11.9");
  });

  it("ranks the exact synonym match first when a query is ambiguous across many rows", () => {
    // "diabetes" subsequence-matches several diabetes rows; the exact 'diabetes'
    // synonym on E11.9 must win the top slot.
    const results = suggestIcd10("diabetes");
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].code).toBe("E11.9");
    const codes = results.map((r) => r.code);
    expect(codes).toContain("E10.9"); // Type 1 also surfaces
  });

  it("orders by score then code for a deterministic result", () => {
    const results = suggestIcd10("arthritis");
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const cur = results[i];
      expect(
        prev.score > cur.score ||
          (prev.score === cur.score && prev.code <= cur.code)
      ).toBe(true);
    }
  });
});

describe("conditionCollapseKey", () => {
  it("keys a coded row on its code (code beats name)", () => {
    // Two differently-named rows sharing a code collapse to ONE key.
    const a = conditionCollapseKey({ code: "E11.9", name: "Type 2 diabetes" });
    const b = conditionCollapseKey({ code: "E11.9", name: "T2DM" });
    expect(a).toBe("code:E11.9");
    expect(a).toBe(b);
  });

  it("falls back to the normalized name when there is no code", () => {
    expect(conditionCollapseKey({ code: null, name: "Asthma" })).toBe(
      "name:asthma"
    );
    expect(conditionCollapseKey({ code: "  ", name: "  Asthma  " })).toBe(
      "name:asthma"
    );
  });

  it("never collapses a coded row with an uncoded same-name row", () => {
    const coded = conditionCollapseKey({ code: "I10", name: "Hypertension" });
    const uncoded = conditionCollapseKey({ code: null, name: "Hypertension" });
    expect(coded).not.toBe(uncoded);
  });

  it("keeps distinct codes in distinct groups", () => {
    expect(conditionCollapseKey({ code: "E10.9", name: "Diabetes" })).not.toBe(
      conditionCollapseKey({ code: "E11.9", name: "Diabetes" })
    );
  });
});

describe("ICD10_SYSTEM", () => {
  it("is the FHIR-export/import round-trip label", () => {
    expect(ICD10_SYSTEM).toBe("ICD-10-CM");
  });
});
