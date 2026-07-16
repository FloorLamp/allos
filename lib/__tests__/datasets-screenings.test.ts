import { describe, expect, it } from "vitest";
import {
  screeningsDataset,
  screeningForKey,
  screeningKeyStrategy,
  SCREENING_ROWS,
  SCREENINGS_REVIEWED,
} from "@/lib/datasets/screenings";
import { citationPresent, identityResolves, refusalGate } from "@/lib/datasets";

// Framework-contract tests for the screenings dataset (issue #860 Track B), migrated
// onto lib/datasets/. These exercise the reusable harness assertions (citation-present,
// identity-resolves, refusal-gate) against the real loaded dataset, and pin the
// behavior-identical key lookup + the dataset-level reviewed date. Pure — no DB, no
// network. (Anti-drift / fixed-point + catalog-reconstruction pins live in
// screenings-dataset.test.ts.)

describe("screenings dataset on the curated-dataset framework", () => {
  it("carries a citation with a source (USPSTF)", () => {
    const r = citationPresent(screeningsDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(screeningsDataset.citation[0].source).toMatch(/USPSTF/i);
  });

  it("exposes the dataset-level reviewed date via meta", () => {
    expect(SCREENINGS_REVIEWED).toMatch(/^\d{4}-\d{2}$/);
    expect(screeningsDataset.meta?.reviewed).toBe(SCREENINGS_REVIEWED);
  });

  it("resolves every entry by its own identity (screening key)", () => {
    const r = identityResolves(screeningsDataset, screeningKeyStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent screening key (returns null — never a guess)", () => {
    const r = refusalGate(screeningsDataset, screeningKeyStrategy, [
      "__no_such_screening__",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(screeningForKey("__no_such_screening__")).toBeNull();
  });

  it("resolves a known screening (behavior-identical lookup)", () => {
    const bp = screeningForKey("blood_pressure");
    expect(bp).toBeTruthy();
    expect(bp!.citation.source).toBe("USPSTF");
    expect(SCREENING_ROWS.length).toBeGreaterThan(0);
  });
});
