import { describe, expect, it } from "vitest";
import {
  normalizeSituationName,
  sameSituation,
  situationForConditionName,
  suggestedSituationsFromConditions,
  mergedSituationOptions,
  nonIllnessSituationOptions,
} from "@/lib/situations";
import { SUGGESTED_SITUATIONS } from "@/lib/supplement-schedule";

describe("mergedSituationOptions (#1221 part 6 / #1177)", () => {
  it("with no vocabulary → exactly the built-in suggestions, none in vocabulary", () => {
    const opts = mergedSituationOptions([]);
    expect(opts.map((o) => o.name)).toEqual([...SUGGESTED_SITUATIONS]);
    expect(opts.every((o) => !o.inVocabulary)).toBe(true);
    expect(opts.every((o) => !o.illnessType)).toBe(true);
  });

  it("puts vocabulary rows first, then the remaining suggestions, NOCASE-deduped", () => {
    const opts = mergedSituationOptions([
      { name: "Migraine", illness_type: 0 },
      { name: "travel", illness_type: 0 }, // collapses onto suggested "Travel"
    ]);
    // Vocabulary order first ("Migraine", the stored "travel"), then the suggestions
    // that didn't collide (Illness / High stress / Poor sleep) — "Travel" is dropped as
    // a dup of the stored "travel".
    expect(opts.map((o) => o.name)).toEqual([
      "Migraine",
      "travel",
      "Illness",
      "High stress",
      "Poor sleep",
    ]);
    const byName = new Map(opts.map((o) => [o.name, o]));
    expect(byName.get("Migraine")!.inVocabulary).toBe(true);
    expect(byName.get("travel")!.inVocabulary).toBe(true);
    expect(byName.get("Illness")!.inVocabulary).toBe(false);
  });

  it("carries the #799 illness-type flag for a saved row", () => {
    const opts = mergedSituationOptions([
      { name: "Kid sick", illness_type: 1 },
    ]);
    expect(opts.find((o) => o.name === "Kid sick")!.illnessType).toBe(true);
  });
});

describe("nonIllnessSituationOptions (#1221 part 6)", () => {
  it("excludes illness-type rows AND the built-in Illness suggestion", () => {
    const opts = nonIllnessSituationOptions([
      { name: "Kid sick", illness_type: 1 }, // illness-type row → excluded
      { name: "Deadline crunch", illness_type: 0 }, // custom non-clinical → kept
    ]);
    const names = opts.map((o) => o.name);
    expect(names).toContain("Deadline crunch");
    expect(names).toContain("Travel");
    expect(names).not.toContain("Kid sick");
    expect(names).not.toContain("Illness"); // the illness door owns that lifecycle
  });

  it("a stored illness-typed 'Illness' row is still excluded", () => {
    const opts = nonIllnessSituationOptions([
      { name: "Illness", illness_type: 1 },
    ]);
    expect(opts.map((o) => o.name)).not.toContain("Illness");
  });
});

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
