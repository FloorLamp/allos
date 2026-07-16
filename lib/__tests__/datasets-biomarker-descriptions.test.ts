import { describe, expect, it } from "vitest";
import {
  biomarkerDescriptionsDataset,
  biomarkerDescriptionForName,
  BIOMARKER_DESCRIPTION_ENTRIES,
} from "@/lib/datasets/biomarker-descriptions";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  nameStrategy,
} from "@/lib/datasets";

// Framework-contract tests for the biomarker-descriptions dataset (issue #860 Track B),
// migrated onto lib/datasets/ (object map → identity-keyed entries array). These
// exercise the reusable harness assertions (citation-present, identity-resolves,
// refusal-gate) against the real loaded dataset, and pin the behavior-identical
// name lookup. Pure — no DB, no network. (Coverage vs the canonical set lives in
// biomarker-descriptions.test.ts.)

describe("biomarker-descriptions dataset on the curated-dataset framework", () => {
  it("carries a citation with a source", () => {
    const r = citationPresent(biomarkerDescriptionsDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(biomarkerDescriptionsDataset.citation[0].source).toMatch(
      /MedlinePlus|Testing\.com|NLM/i
    );
  });

  it("resolves every entry by its own identity (canonical name)", () => {
    const r = identityResolves(biomarkerDescriptionsDataset, nameStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent biomarker name (returns null — never a guess)", () => {
    const r = refusalGate(biomarkerDescriptionsDataset, nameStrategy, [
      "Definitely Not A Biomarker",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(
      biomarkerDescriptionForName("Definitely Not A Biomarker")
    ).toBeNull();
  });

  it("matches a known biomarker case-insensitively (behavior-identical lookup)", () => {
    const tc = biomarkerDescriptionForName("total cholesterol");
    expect(tc).toBeTruthy();
    expect(tc!.full_name).toBe("Total Cholesterol");
    expect(BIOMARKER_DESCRIPTION_ENTRIES.length).toBeGreaterThan(100);
  });
});
