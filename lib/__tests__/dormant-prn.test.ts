import { describe, it, expect } from "vitest";
import {
  dormantPrnCandidates,
  dormantPrnDismissalKey,
  DORMANT_PRN_PREFIX,
  type DormantPrnInput,
} from "@/lib/dormant-prn";

// Pure dormant-PRN sweep (issue #880 item 3). Active PRN meds with no dose in 90+ days,
// anchored on the last administration (or creation, if never dosed). Dismissal is id-keyed
// (#203): integer ids never recycle, so it can't mis-suppress a later same-named med.

const TODAY = "2026-06-01";

function m(over: Partial<DormantPrnInput>): DormantPrnInput {
  return {
    itemId: 1,
    name: "Ibuprofen",
    asNeeded: true,
    active: true,
    lastAdministration: "2026-01-01", // ~151 days ago
    createdOn: "2025-01-01",
    ...over,
  };
}

describe("dormantPrnCandidates", () => {
  it("flags an active PRN med with no dose in 90+ days", () => {
    const out = dormantPrnCandidates([m({})], TODAY);
    expect(out).toHaveLength(1);
    expect(out[0].itemId).toBe(1);
    expect(out[0].daysSince).toBeGreaterThanOrEqual(90);
    expect(out[0].lastUsed).toBe("2026-01-01");
    expect(out[0].dedupeKey).toBe(`${DORMANT_PRN_PREFIX}1`);
  });

  it("does NOT flag a recently-dosed PRN med", () => {
    expect(
      dormantPrnCandidates([m({ lastAdministration: "2026-05-20" })], TODAY)
    ).toEqual([]);
  });

  it("uses the creation date when the med was never dosed", () => {
    const out = dormantPrnCandidates(
      [m({ lastAdministration: null, createdOn: "2025-01-01" })],
      TODAY
    );
    expect(out).toHaveLength(1);
    expect(out[0].lastUsed).toBeNull();
  });

  it("does NOT flag a never-dosed med created recently", () => {
    expect(
      dormantPrnCandidates(
        [m({ lastAdministration: null, createdOn: "2026-05-01" })],
        TODAY
      )
    ).toEqual([]);
  });

  it("ignores non-PRN and inactive meds", () => {
    expect(dormantPrnCandidates([m({ asNeeded: false })], TODAY)).toEqual([]);
    expect(dormantPrnCandidates([m({ active: false })], TODAY)).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const med = m({ lastAdministration: "2026-04-01" }); // ~61 days
    expect(dormantPrnCandidates([med], TODAY, 90)).toEqual([]);
    expect(dormantPrnCandidates([med], TODAY, 30)).toHaveLength(1);
  });

  it("sorts longest-dormant first", () => {
    const out = dormantPrnCandidates(
      [
        m({ itemId: 1, name: "A", lastAdministration: "2026-03-01" }),
        m({ itemId: 2, name: "B", lastAdministration: "2025-06-01" }),
      ],
      TODAY
    );
    expect(out.map((s) => s.itemId)).toEqual([2, 1]);
  });
});

describe("dormantPrnDismissalKey", () => {
  it("is id-keyed (ids never recycle)", () => {
    expect(dormantPrnDismissalKey(42)).toBe("dormant-prn:42");
  });
});
