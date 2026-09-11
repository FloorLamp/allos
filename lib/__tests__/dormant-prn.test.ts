import { describe, it, expect } from "vitest";
import {
  DEFAULT_DORMANT_DAYS,
  dormantPrnCandidates,
  dormantPrnDismissalKey,
  DORMANT_PRN_PREFIX,
  type DormantPrnInput,
} from "@/lib/dormant-prn";
import { DORMANCY_DEFAULT_DAYS } from "@/lib/domain-dormancy";
import { shiftDateStr } from "@/lib/date";

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
    createdOnLocalDay: "2025-01-01",
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
      [m({ lastAdministration: null, createdOnLocalDay: "2025-01-01" })],
      TODAY
    );
    expect(out).toHaveLength(1);
    expect(out[0].lastUsed).toBeNull();
  });

  it("does NOT flag a never-dosed med created recently", () => {
    expect(
      dormantPrnCandidates(
        [m({ lastAdministration: null, createdOnLocalDay: "2026-05-01" })],
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

  it("drops a never-dosed med whose created day could not be resolved", () => {
    expect(
      dormantPrnCandidates(
        [m({ lastAdministration: null, createdOnLocalDay: null })],
        TODAY
      )
    ).toEqual([]);
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

// #4242 — the sweep is a TENANT of the dormancy registry: "has this stopped arriving?"
// has one owner-ruled interval, and medications used to re-declare it independently, so a
// doctrine change reached every dormancy surface except this one.
//
// HONEST ABOUT WHAT THIS PINS. A re-declared literal would still satisfy the equality
// below while the two agree; what stops the drift is the by-reference declaration in the
// module, not this assertion. What the assertion buys is the FAILURE when somebody moves
// the registry's interval and the sweep does not follow — which is exactly the shape the
// defect took, and which a bare `toBe(90)` would have passed through in silence.
describe("the PRN sweep is a dormancy tenant (#4242)", () => {
  it("takes the registry's interval rather than declaring its own", () => {
    expect(DEFAULT_DORMANT_DAYS).toBe(DORMANCY_DEFAULT_DAYS);
  });

  it("the default threshold used by the sweep is that interval", () => {
    const justInside = dormantPrnCandidates(
      [
        m({
          lastAdministration: shiftDateStr(TODAY, -(DORMANCY_DEFAULT_DAYS - 1)),
        }),
      ],
      TODAY
    );
    const atTheInterval = dormantPrnCandidates(
      [m({ lastAdministration: shiftDateStr(TODAY, -DORMANCY_DEFAULT_DAYS) })],
      TODAY
    );
    expect(justInside).toEqual([]);
    expect(atTheInterval).toHaveLength(1);
  });
});
