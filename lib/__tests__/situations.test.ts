import { describe, expect, it } from "vitest";
import {
  normalizeSituationName,
  sameSituation,
  situationForConditionName,
  suggestedSituationsFromConditions,
} from "@/lib/situations";

describe("normalizeSituationName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(normalizeSituationName("  Poor   sleep ")).toBe("Poor sleep");
    expect(normalizeSituationName("Travel")).toBe("Travel");
    expect(normalizeSituationName("   ")).toBe("");
  });
});

describe("sameSituation", () => {
  it("is case- and whitespace-insensitive (the #203 fragility this removes)", () => {
    expect(sameSituation("Illness", "illness")).toBe(true);
    expect(sameSituation(" Poor  sleep", "poor sleep ")).toBe(true);
    expect(sameSituation("Illness", "Sickness")).toBe(false);
  });
});

describe("situationForConditionName", () => {
  it("maps illness-type conditions to Illness", () => {
    expect(situationForConditionName("Influenza A")).toBe("Illness");
    expect(situationForConditionName("Acute viral infection")).toBe("Illness");
    expect(situationForConditionName("COVID-19")).toBe("Illness");
  });

  it("maps injury-type conditions to Injury", () => {
    expect(situationForConditionName("Left ankle sprain")).toBe("Injury");
    expect(situationForConditionName("Hamstring strain")).toBe("Injury");
    expect(situationForConditionName("Distal radius fracture")).toBe("Injury");
  });

  it("returns null for unrelated / non-clinical conditions", () => {
    expect(situationForConditionName("Hypertension")).toBeNull();
    expect(situationForConditionName("Type 2 diabetes")).toBeNull();
  });
});

describe("suggestedSituationsFromConditions", () => {
  it("suggests the clinical situation an active condition implies", () => {
    expect(suggestedSituationsFromConditions(["Influenza A"], [])).toEqual([
      "Illness",
    ]);
  });

  it("omits a situation that is already active (no second toggle)", () => {
    expect(
      suggestedSituationsFromConditions(["Influenza A"], ["Illness"])
    ).toEqual([]);
    // Case-insensitively already-active.
    expect(
      suggestedSituationsFromConditions(["Influenza A"], ["illness"])
    ).toEqual([]);
  });

  it("de-duplicates and preserves a stable order across conditions", () => {
    expect(
      suggestedSituationsFromConditions(
        ["Common cold", "Ankle sprain", "Sinusitis"],
        []
      )
    ).toEqual(["Illness", "Injury"]);
  });

  it("ignores conditions with no clinical-situation mapping", () => {
    expect(suggestedSituationsFromConditions(["Hypertension"], [])).toEqual([]);
  });
});
