import { describe, expect, it } from "vitest";
import {
  biomarkerOutcomeOption,
  outcomeOptionMatches,
  protocolRelevantPanels,
  rankProtocolOutcomeOptions,
  type OutcomeOption,
} from "@/lib/protocol-outcome-picker";
import { PRACTICE_STARTER_LIST } from "@/lib/practice";

function fixed(key: string, label: string): OutcomeOption {
  return {
    key,
    label,
    group: "Body & indices",
    panel: null,
    searchTerms: [],
  };
}

describe("protocol outcome picker (#1586)", () => {
  it("matches substrings and canonical aliases", () => {
    const apoB = biomarkerOutcomeOption("Apolipoprotein B (ApoB)");
    const a1c = biomarkerOutcomeOption("Hemoglobin A1c");

    expect(outcomeOptionMatches(apoB, "polipoprotein")).toBe(true);
    expect(outcomeOptionMatches(a1c, "HbA1c")).toBe(true);
    expect(outcomeOptionMatches(a1c, "rubella")).toBe(false);
  });

  it("ranks relevant panels first without dropping or reordering the rest", () => {
    const weight = fixed("metric:weight", "Body weight");
    const rubella = biomarkerOutcomeOption("Rubella IgG");
    const vitaminD = biomarkerOutcomeOption("Vitamin D, 25-Hydroxy");
    const options = [weight, rubella, vitaminD];

    const ranked = rankProtocolOutcomeOptions(
      options,
      protocolRelevantPanels({
        templateOutcomeKeys: ["biomarker:Vitamin D, 25-Hydroxy"],
      })
    );

    expect(ranked.map((option) => option.key)).toEqual([
      vitaminD.key,
      weight.key,
      rubella.key,
    ]);
    expect(new Set(ranked.map((option) => option.key))).toEqual(
      new Set(options.map((option) => option.key))
    );
  });

  it("ranks changed and comparable outcomes ahead of relevance-only hints", () => {
    const weight = fixed("metric:weight", "Body weight");
    weight.preview = {
      beforeMean: 80,
      duringMean: 78,
      meanDelta: -2,
      unit: "kg",
      beforeN: 3,
      duringN: 4,
    };
    const unchanged = fixed("metric:resting_hr", "Resting heart rate");
    unchanged.preview = {
      beforeMean: 60,
      duringMean: 60,
      meanDelta: 0,
      unit: "bpm",
      beforeN: 5,
      duringN: 5,
    };
    const relevant = biomarkerOutcomeOption("Vitamin D, 25-Hydroxy");

    expect(
      rankProtocolOutcomeOptions(
        [relevant, unchanged, weight],
        new Set(["vitamins"])
      ).map((option) => option.key)
    ).toEqual([weight.key, unchanged.key, relevant.key]);
  });

  it("derives panel hints from practice and intake signals", () => {
    const panels = protocolRelevantPanels({
      practice: "cardio",
      intakeItemName: "Creatine monohydrate",
    });
    expect(panels).toEqual(
      new Set(["fitness", "vital-signs", "body-composition", "kidney"])
    );
  });

  it("gives every curated wellness practice a relevance seed", () => {
    for (const practice of PRACTICE_STARTER_LIST) {
      expect(
        protocolRelevantPanels({ practice }).size,
        practice
      ).toBeGreaterThan(0);
    }
  });
});
