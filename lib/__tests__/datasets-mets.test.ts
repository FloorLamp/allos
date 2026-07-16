import { describe, expect, it } from "vitest";
import { metsDataset, metEntryForName } from "@/lib/datasets/mets";
import {
  citationPresent,
  identityResolves,
  refusalGate,
  nameStrategy,
} from "@/lib/datasets";

// Framework-contract tests for the mets dataset (issue #860 Track B) — the FIRST
// dataset migrated onto lib/datasets/. These exercise the reusable harness
// assertions (citation-present, identity-resolves, refusal-gate) against the real
// loaded dataset, and pin the behavior-identical lookup the estimator relies on.
// Pure — no DB, no network.

describe("mets dataset on the curated-dataset framework", () => {
  it("carries a citation with a source (the Compendium)", () => {
    const r = citationPresent(metsDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(metsDataset.citation[0].source).toMatch(/Compendium/i);
  });

  it("resolves every entry by its own identity (activity name)", () => {
    const r = identityResolves(metsDataset, nameStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent activity (returns null — never a guess)", () => {
    const r = refusalGate(metsDataset, nameStrategy, [
      "Underwater Basket Weaving",
      "",
      "   ",
    ]);
    expect(r.problems).toEqual([]);
    expect(metEntryForName("Underwater Basket Weaving")).toBeNull();
  });

  it("matches a known activity case-insensitively (behavior-identical lookup)", () => {
    const running = metEntryForName("running");
    expect(running).not.toBeNull();
    expect(running!.name).toBe("Running");
    expect(running!.easy).toBeLessThanOrEqual(running!.hard);
  });
});
