import { describe, it, expect } from "vitest";
import {
  itemAffordanceVisible,
  subjectChipVisible,
  viewCountLabel,
  parseViewMode,
  readForProfiles,
} from "@/lib/multi-view";

// Pure-tier coverage for the shared multi-view RENDERING RULES (lib/multi-view.ts, issue
// #1327) — the rules #1328's Tier-1 fan-out consumes. Each is a small decision the
// flagship used to hand-roll per page; pinning them here is what lets the umbrella reuse
// one implementation.

describe("itemAffordanceVisible (issue #1327 fix 5 — the writeTarget auto-gate)", () => {
  it("item-targeted (default): follows the subject's write access", () => {
    // A dose/preventive/care-plan action writes to the ROW's subject; a read-only member's
    // rows show no write buttons.
    expect(
      itemAffordanceVisible(undefined, {
        isActing: false,
        subjectCanWrite: true,
      })
    ).toBe(true);
    expect(
      itemAffordanceVisible("item", { isActing: false, subjectCanWrite: false })
    ).toBe(false);
  });

  it("acting-targeted: shows ONLY on the acting profile's own row", () => {
    // A condition-suggestion confirm writes to the ACTING profile no matter whose row it
    // is, so it must never render on another member's row (the #1013 wrong-profile write).
    expect(
      itemAffordanceVisible("acting", { isActing: true, subjectCanWrite: true })
    ).toBe(true);
    expect(
      itemAffordanceVisible("acting", {
        isActing: false,
        subjectCanWrite: true,
      })
    ).toBe(false);
  });

  it("single-view collapses both branches to shown (every row IS the acting profile)", () => {
    // In single-view subject is null → subjectCanWrite true, and the row is the acting
    // profile → isActing true; both writeTargets render, so the single-profile page is
    // unchanged.
    const single = { isActing: true, subjectCanWrite: true };
    expect(itemAffordanceVisible("item", single)).toBe(true);
    expect(itemAffordanceVisible("acting", single)).toBe(true);
  });
});

describe("subjectChipVisible (issue #1327 fix 1 — chip only where it informs)", () => {
  it("never in single-view", () => {
    expect(subjectChipVisible({ multi: false, isActing: false })).toBe(false);
    expect(subjectChipVisible({ multi: false, isActing: true })).toBe(false);
  });

  it("multi-view: chips NON-acting rows, never the acting profile's own", () => {
    expect(subjectChipVisible({ multi: true, isActing: false })).toBe(true);
    // The acting profile's rows are implied by the view strip — chipping them just
    // doubles density (nine "admin" chips in the seeded 3-profile Overdue band).
    expect(subjectChipVisible({ multi: true, isActing: true })).toBe(false);
  });
});

describe("viewCountLabel (issue #1327 fix 6 — the labeled view-set badge)", () => {
  it("single view keeps the plain total", () => {
    expect(viewCountLabel(54, 1)).toBe("54 total");
  });

  it("multi view names the profile span so it can't read as a contradiction", () => {
    // Against the acting-only hero (54), a bare "95" reads as a bug; "95 across 3
    // profiles" reconciles.
    expect(viewCountLabel(95, 3)).toBe("95 across 3 profiles");
  });
});

describe("parseViewMode (issue #1327 fix 2 — the ordering toggle)", () => {
  it("defaults to interleaved for absent/unknown/array params", () => {
    expect(parseViewMode(undefined)).toBe("interleaved");
    expect(parseViewMode("nonsense")).toBe("interleaved");
    expect(parseViewMode(["by-person", "x"])).toBe("by-person");
  });

  it("selects by-person on the explicit value", () => {
    expect(parseViewMode("by-person")).toBe("by-person");
  });
});

describe("readForProfiles (issue #1328 — loop-composition for the Tier-1 lists)", () => {
  it("tags each row with the profile it came from, in view order", () => {
    const reader = (pid: number) => [
      { id: pid * 10 + 1 },
      { id: pid * 10 + 2 },
    ];
    const rows = readForProfiles([2, 5], reader);
    expect(rows).toEqual([
      { id: 21, profileId: 2 },
      { id: 22, profileId: 2 },
      { id: 51, profileId: 5 },
      { id: 52, profileId: 5 },
    ]);
  });

  it("single-view (ids = [acting]) returns exactly the per-profile reader's rows, tagged", () => {
    const reader = (pid: number) => [{ name: `row-${pid}` }];
    expect(readForProfiles([7], reader)).toEqual([
      { name: "row-7", profileId: 7 },
    ]);
  });

  it("an empty view-set yields no rows", () => {
    expect(readForProfiles([], () => [{ id: 1 }])).toEqual([]);
  });
});
