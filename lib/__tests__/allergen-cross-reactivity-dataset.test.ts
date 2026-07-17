import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAllergenCrossReactivityDataset } from "@/scripts/gen-allergen-cross-reactivity";
import dataset from "@/lib/datasets/data/allergen-cross-reactivity.json";
import {
  allergenCrossReactivityDataset,
  allergenFamilyStrategy,
} from "@/lib/datasets/allergen-cross-reactivity";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  noKeyCollisions,
  runHarness,
} from "@/lib/datasets";
import { findCrossReactivity } from "@/lib/allergen-cross-reactivity";
import { allergenConflict } from "@/lib/supplement-safety";

// Anti-drift + framework-contract pins for the baked allergen cross-reactivity dataset
// (issue #153, migrated onto the curated-dataset framework in #860 Track B). This dataset
// is SAFETY-critical — it backs the #691 allergy safety belt (allergenConflict), which
// drops a supplement whose ingredient is a cross-reactive relative of a recorded allergen.
// The committed lib/datasets/data JSON must be a FIXED POINT of the generator, pass the
// framework harness (citation / identity / refusal / no-collisions), and BOTH the
// informational matcher (findCrossReactivity) and the safety belt (allergenConflict) must
// stay behavior-identical. Pure — reads the generator + committed JSON, no DB/network.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = path.join(REPO, "lib/datasets/data/allergen-cross-reactivity.json");

describe("allergen-cross-reactivity.json dataset", () => {
  it("is a fixed point of buildAllergenCrossReactivityDataset() (regenerate with `npm run gen:allergen-cross-reactivity`)", () => {
    const generated =
      JSON.stringify(buildAllergenCrossReactivityDataset(), null, 2) + "\n";
    const committed = fs.readFileSync(OUT, "utf8");
    expect(committed).toBe(generated);
  });

  it("passes the framework harness (citation / identity slug / refusal / no collisions)", () => {
    const r = runHarness(
      allergenCrossReactivityDataset,
      allergenFamilyStrategy
    );
    expect(r.ok, r.problems.join("; ")).toBe(true);
  });

  it("carries a dataset citation with a source", () => {
    expect(citationPresent(allergenCrossReactivityDataset).problems).toEqual(
      []
    );
    expect(
      allergenCrossReactivityDataset.citation[0].source.length
    ).toBeGreaterThan(0);
  });

  it("resolves every family by its own slug identity, with no collisions", () => {
    expect(
      identityResolves(allergenCrossReactivityDataset, allergenFamilyStrategy)
        .problems
    ).toEqual([]);
    expect(
      noKeyCollisions(allergenCrossReactivityDataset, allergenFamilyStrategy)
        .problems
    ).toEqual([]);
  });

  it("refuses an absent family id (returns null — never a guess)", () => {
    expect(
      refusalGate(allergenCrossReactivityDataset, allergenFamilyStrategy, [
        "no-such-family",
        "",
      ]).problems
    ).toEqual([]);
  });

  it("gives every family a unique id, >1 member, a label and a citation", () => {
    const ids = new Set<string>();
    for (const f of dataset.entries) {
      expect(f.id.trim().length, f.id).toBeGreaterThan(0);
      expect(ids.has(f.id), `duplicate ${f.id}`).toBe(false);
      ids.add(f.id);
      expect(f.members.length, f.id).toBeGreaterThan(1);
      expect(f.label.trim().length, f.id).toBeGreaterThan(0);
      expect(f.citation.trim().length, f.id).toBeGreaterThan(0);
    }
  });
});

describe("informational matcher is behavior-identical (findCrossReactivity)", () => {
  it("surfaces birch-OAS from a birch sensitization with the expected relatives", () => {
    const [m, ...rest] = findCrossReactivity(["Birch"]);
    expect(rest).toHaveLength(0);
    expect(m.familyId).toBe("birch-oas");
    expect(m.related).toEqual(
      expect.arrayContaining(["apple", "cherry", "hazelnut", "kiwi"])
    );
    expect(m.note).toContain("commonly cross-reacts with");
    expect(m.note).toContain("Informational only");
  });

  it("kiwi surfaces BOTH birch-OAS and latex-fruit (multi-family)", () => {
    const ids = findCrossReactivity(["Kiwi"])
      .map((m) => m.familyId)
      .sort();
    expect(ids).toEqual(["birch-oas", "latex-fruit"]);
  });

  it("returns nothing for an allergen in no family", () => {
    expect(findCrossReactivity(["Penicillin", "Pollen"])).toEqual([]);
  });
});

describe("SAFETY belt is behavior-identical (allergenConflict, #691/#153)", () => {
  it("REGRESSION: drops krill oil for a shrimp allergy via cross-reactivity", () => {
    const hit = allergenConflict("Krill Oil", ["shrimp"]);
    expect(hit?.viaCrossReactivity).toBeTruthy();
    expect(hit?.allergen.toLowerCase()).toContain("shrimp");
  });

  it("does not drop an unrelated supplement", () => {
    expect(
      allergenConflict("Magnesium Glycinate", ["shrimp", "penicillin"])
    ).toBeNull();
  });
});
