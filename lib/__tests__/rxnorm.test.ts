import { describe, expect, it } from "vitest";
import {
  parseApproximateTerm,
  parseRelatedIngredients,
  parseRxcuiIngredients,
  serializeRxcuiIngredients,
} from "@/lib/rxnorm";

// Pure parsing of NLM RxNav's approximateTerm response (issue #144) and of the
// related-by-type ingredient decomposition + its storage codec (issue #279). The
// network fetches themselves aren't unit-tested (they're the only egress and
// degrade to [] on error); this pins the response-shape handling. Synthetic
// responses; RxCUIs are public-domain RxNorm vocabulary codes, not PHI.

describe("parseApproximateTerm", () => {
  it("returns [] for a missing/empty response", () => {
    expect(parseApproximateTerm(undefined)).toEqual([]);
    expect(parseApproximateTerm({})).toEqual([]);
    expect(parseApproximateTerm({ approximateGroup: {} })).toEqual([]);
  });

  it("extracts candidates, coercing the string score to a number", () => {
    const json = {
      approximateGroup: {
        candidate: [
          { rxcui: "11289", score: "75", name: "warfarin" },
          { rxcui: "5640", score: "40", name: "ibuprofen" },
        ],
      },
    };
    const out = parseApproximateTerm(json);
    expect(out).toEqual([
      { rxcui: "11289", name: "warfarin", score: 75 },
      { rxcui: "5640", name: "ibuprofen", score: 40 },
    ]);
  });

  it("de-duplicates by RxCUI, keeping the highest score", () => {
    const json = {
      approximateGroup: {
        candidate: [
          { rxcui: "11289", score: "30", name: "warfarin" },
          { rxcui: "11289", score: "90", name: "warfarin" },
        ],
      },
    };
    const out = parseApproximateTerm(json);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ rxcui: "11289", name: "warfarin", score: 90 });
  });

  it("sorts best score first and honors the limit", () => {
    const json = {
      approximateGroup: {
        candidate: [
          { rxcui: "1", score: "10" },
          { rxcui: "2", score: "50" },
          { rxcui: "3", score: "30" },
        ],
      },
    };
    const out = parseApproximateTerm(json, 2);
    expect(out.map((c) => c.rxcui)).toEqual(["2", "3"]);
  });

  it("skips candidates with no rxcui", () => {
    const json = {
      approximateGroup: {
        candidate: [
          { score: "50", name: "no code" },
          { rxcui: "5", score: "20" },
        ],
      },
    };
    const out = parseApproximateTerm(json);
    expect(out).toEqual([{ rxcui: "5", name: "", score: 20 }]);
  });
});

describe("parseRelatedIngredients", () => {
  it("returns [] for a missing/empty response", () => {
    expect(parseRelatedIngredients(undefined)).toEqual([]);
    expect(parseRelatedIngredients({})).toEqual([]);
    expect(parseRelatedIngredients({ relatedGroup: {} })).toEqual([]);
    expect(
      parseRelatedIngredients({ relatedGroup: { conceptGroup: [] } })
    ).toEqual([]);
  });

  it("extracts the ingredient (tty IN) RxCUIs of a combination product", () => {
    // A combo product decomposes into TWO ingredient concepts — the issue #279
    // shape (losartan/hydrochlorothiazide). Synthetic response, real public CUIs.
    const json = {
      relatedGroup: {
        conceptGroup: [
          {
            tty: "IN",
            conceptProperties: [
              { rxcui: "52175", name: "losartan" },
              { rxcui: "5487", name: "hydrochlorothiazide" },
            ],
          },
        ],
      },
    };
    expect(parseRelatedIngredients(json)).toEqual(["52175", "5487"].sort());
  });

  it("ignores non-IN concept groups and a null conceptProperties", () => {
    const json = {
      relatedGroup: {
        conceptGroup: [
          { tty: "BN", conceptProperties: [{ rxcui: "111" }] },
          { tty: "IN", conceptProperties: null },
          { tty: "IN", conceptProperties: [{ rxcui: "52175" }] },
        ],
      },
    };
    expect(parseRelatedIngredients(json)).toEqual(["52175"]);
  });

  it("drops malformed CUIs and de-duplicates", () => {
    const json = {
      relatedGroup: {
        conceptGroup: [
          {
            tty: "IN",
            conceptProperties: [
              { rxcui: "52175" },
              { rxcui: "52175" },
              { rxcui: "not-a-code" },
              { rxcui: "" },
              {},
            ],
          },
        ],
      },
    };
    expect(parseRelatedIngredients(json)).toEqual(["52175"]);
  });
});

describe("rxcui_ingredients codec", () => {
  it("round-trips a list through serialize/parse", () => {
    const raw = serializeRxcuiIngredients(["52175", "5487"]);
    expect(raw).toBeTruthy();
    expect(parseRxcuiIngredients(raw)).toEqual(["52175", "5487"].sort());
  });

  it("serializes an empty list to null (never stores '[]' noise)", () => {
    expect(serializeRxcuiIngredients([])).toBeNull();
    expect(serializeRxcuiIngredients(["nope"])).toBeNull();
  });

  it("parse tolerates null/garbage/forged input (untrusted column + form field)", () => {
    expect(parseRxcuiIngredients(null)).toEqual([]);
    expect(parseRxcuiIngredients("")).toEqual([]);
    expect(parseRxcuiIngredients("not json")).toEqual([]);
    expect(parseRxcuiIngredients('{"a":1}')).toEqual([]);
    // Non-CUI members are dropped, plausible ones kept; numbers are coerced.
    expect(
      parseRxcuiIngredients('["52175", "DROP TABLE", 5487, {"x":1}, null]')
    ).toEqual(["52175", "5487"].sort());
  });

  it("parse de-duplicates and caps a hostile oversized payload", () => {
    const big = JSON.stringify(
      Array.from({ length: 500 }, (_, i) => String(100000 + i))
    );
    expect(parseRxcuiIngredients(big).length).toBeLessThanOrEqual(25);
    expect(parseRxcuiIngredients('["1","1","2"]')).toEqual(["1", "2"]);
  });
});
