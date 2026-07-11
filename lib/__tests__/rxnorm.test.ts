import { describe, expect, it } from "vitest";
import { parseApproximateTerm } from "@/lib/rxnorm";

// Pure parsing of NLM RxNav's approximateTerm response (issue #144). The network
// fetch itself isn't unit-tested (it's the only egress and degrades to [] on error);
// this pins the response-shape handling. Synthetic RxCUIs only.

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
