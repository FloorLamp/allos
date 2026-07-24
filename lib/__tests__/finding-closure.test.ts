// PURE TIER — the findings-closure differ + toast formatter (issue #1305). The DB
// re-run half (withFindingClosure) is covered per satisfier in the DB tier; this pins
// the pure pieces the loop rests on: what "cleared" means, and how the acknowledgment
// reads.

import { describe, it, expect } from "vitest";
import { clearedFindings, formatClosureToast } from "@/lib/finding-closure";
import type { Finding } from "@/lib/findings";

function f(dedupeKey: string, title = dedupeKey): Finding {
  return { domain: "coaching", dedupeKey, title };
}

describe("clearedFindings (#1305)", () => {
  it("names a finding active before that is gone after", () => {
    const before = [
      f("fitness-check:retest:2026-01-01"),
      f("data-quality:sex"),
    ];
    const after = [f("data-quality:sex")];
    expect(clearedFindings(before, after).map((x) => x.dedupeKey)).toEqual([
      "fitness-check:retest:2026-01-01",
    ]);
  });

  it("clears nothing when the finding is still active after (the common case)", () => {
    const both = [f("data-quality:birthdate")];
    expect(clearedFindings(both, both)).toEqual([]);
  });

  it("clears nothing when the set was empty before (a write that satisfied no finding)", () => {
    expect(clearedFindings([], [f("data-quality:sex")])).toEqual([]);
  });

  it("collapses a dedupeKey that appears twice in `before` to one cleared entry", () => {
    const before = [f("data-quality:sex"), f("data-quality:sex")];
    expect(clearedFindings(before, [])).toHaveLength(1);
  });
});

describe("formatClosureToast (#1305)", () => {
  it("returns null when nothing cleared (silence is the common case)", () => {
    expect(formatClosureToast([])).toBeNull();
  });

  it("prefixes a single default clear with 'That cleared:'", () => {
    expect(
      formatClosureToast([f("data-quality:birthdate", "Set a birthdate")])
    ).toBe("That cleared: Set a birthdate");
  });

  it("uses a bespoke VERBATIM override for a multi-step satisfier (fitness retest)", () => {
    const cleared = [f("fitness-check:retest:2026-01-01", "Fitness check due")];
    expect(
      formatClosureToast(cleared, {
        "fitness-check:":
          "Fitness check refreshed — retest clock restarts today.",
      })
    ).toBe("Fitness check refreshed — retest clock restarts today.");
  });

  it("collapses several clears into one 'Cleared N items' line", () => {
    const cleared = [
      f("data-quality:birthdate", "Set a birthdate"),
      f("data-quality:sex", "Set a biological sex"),
    ];
    expect(formatClosureToast(cleared)).toBe(
      "Cleared 2 items: Set a birthdate, Set a biological sex"
    );
  });
});
