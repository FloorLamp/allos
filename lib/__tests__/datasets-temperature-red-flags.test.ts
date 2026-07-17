import { describe, expect, it } from "vitest";
import {
  tempRedFlagsDataset,
  tempRedFlagKeyStrategy,
  tempRedFlagForKey,
  detectTempRedFlag,
  TEMP_RED_FLAG_ENTRIES,
} from "@/lib/datasets/temperature-red-flags";
import { citationPresent, identityResolves, refusalGate } from "@/lib/datasets";

// Framework-contract + domain tests for the single-reading fever red-flags dataset
// (issue #859 item 3, #860 Track B). Exercises the reusable harness assertions
// (citation-present, identity-resolves, refusal-gate) against the real loaded dataset,
// and pins the age-banded detection behavior. Pure — no DB, no network.

describe("temperature-red-flags dataset on the curated-dataset framework", () => {
  it("carries a cited AAP-grade source", () => {
    const r = citationPresent(tempRedFlagsDataset);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(tempRedFlagsDataset.citation[0].source).toMatch(/AAP|Pediatrics/i);
  });

  it("resolves every entry by its own identity (rule key)", () => {
    const r = identityResolves(tempRedFlagsDataset, tempRedFlagKeyStrategy);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("refuses an absent rule key (returns null — never a guess)", () => {
    const r = refusalGate(tempRedFlagsDataset, tempRedFlagKeyStrategy, [
      "__no_such_rule__",
      "",
    ]);
    expect(r.problems).toEqual([]);
    expect(tempRedFlagForKey("__no_such_rule__")).toBeNull();
  });

  it("has exactly the two AAP-grade rules", () => {
    expect(TEMP_RED_FLAG_ENTRIES.map((e) => e.key).sort()).toEqual([
      "hyperpyrexia",
      "infant_fever",
    ]);
  });
});

describe("detectTempRedFlag — age-banded single-reading detection", () => {
  it("flags any fever in an infant under 3 months (age known & below band)", () => {
    const hit = detectTempRedFlag(100.6, 2); // 2-month-old, low fever
    expect(hit?.key).toBe("infant_fever");
    expect(hit?.source).toMatch(/AAP|Pediatrics/i);
    // Renders the SOURCE's own instruction, not a computed judgment.
    expect(hit?.line).toMatch(/contact a clinician/i);
  });

  it("does NOT flag an infant band when the fever is below the fever threshold", () => {
    // 99.9°F is below the 100.4°F fever floor — no note, even for a young infant.
    expect(detectTempRedFlag(99.9, 1)).toBeNull();
  });

  it("does NOT trigger the infant band for an older child", () => {
    // 8 months old, low fever — the infant band is age-gated, so no note.
    expect(detectTempRedFlag(101, 8)).toBeNull();
  });

  it("does NOT trigger the infant band when age is unknown", () => {
    // Unknown age never triggers a source-published age band (#805 non-goal).
    expect(detectTempRedFlag(101, null)).toBeNull();
  });

  it("flags a very high fever (>=104°F) at ANY age, including unknown", () => {
    expect(detectTempRedFlag(104, null)?.key).toBe("hyperpyrexia");
    expect(detectTempRedFlag(105.2, 40 * 12)?.key).toBe("hyperpyrexia");
  });

  it("returns the infant band first when a young infant also has a very high fever", () => {
    // Both rules apply; the most-specific (infant) band wins.
    expect(detectTempRedFlag(104.5, 1)?.key).toBe("infant_fever");
  });

  it("refuses (null) a plain reading that crosses no rule", () => {
    expect(detectTempRedFlag(100.8, 30 * 12)).toBeNull(); // adult low fever, no flag
    expect(detectTempRedFlag(98.6, 1)).toBeNull(); // no fever at all
  });
});
