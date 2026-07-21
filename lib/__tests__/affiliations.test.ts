import { describe, it, expect } from "vitest";
import {
  affiliationPairKey,
  normalizeCoOccurrence,
  suggestAffiliations,
  type CoOccurrence,
} from "@/lib/affiliations";

// The pure co-occurrence affiliation suggester (issue #1055). A clinician↔facility
// co-occurrence becomes a suggested individual↔organization edge; a same-type pair is
// structurally impossible; a linked or declined pair is never re-suggested.

const co = (
  clinicianId: number,
  clinicianType: "individual" | "organization",
  facilityId: number,
  facilityType: "individual" | "organization",
  sharedVisits: number
): CoOccurrence => ({
  clinicianId,
  clinicianType,
  facilityId,
  facilityType,
  sharedVisits,
});

describe("normalizeCoOccurrence — the type invariant", () => {
  it("folds an individual clinician + org facility to the canonical pair", () => {
    expect(
      normalizeCoOccurrence(co(1, "individual", 2, "organization", 3))
    ).toEqual({ individualId: 1, organizationId: 2 });
  });

  it("normalizes the inverted org-attending / individual-location shape", () => {
    expect(
      normalizeCoOccurrence(co(2, "organization", 1, "individual", 1))
    ).toEqual({ individualId: 1, organizationId: 2 });
  });

  it("drops an individual↔individual co-occurrence (not an affiliation)", () => {
    expect(
      normalizeCoOccurrence(co(1, "individual", 3, "individual", 5))
    ).toBeNull();
  });

  it("drops an organization↔organization co-occurrence", () => {
    expect(
      normalizeCoOccurrence(co(2, "organization", 4, "organization", 5))
    ).toBeNull();
  });

  it("drops a self-pair", () => {
    expect(
      normalizeCoOccurrence(co(1, "individual", 1, "organization", 2))
    ).toBeNull();
  });
});

describe("suggestAffiliations", () => {
  const empty = new Set<string>();

  it("suggests an edge from a shared visit (≥1 ⇒ strong)", () => {
    const out = suggestAffiliations(
      [co(1, "individual", 2, "organization", 6)],
      empty,
      empty
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      individualId: 1,
      organizationId: 2,
      sharedVisits: 6,
      strength: "strong",
    });
  });

  it("merges duplicate pairs by summing shared visits and sorts strongest first", () => {
    const out = suggestAffiliations(
      [
        co(1, "individual", 2, "organization", 2),
        co(1, "individual", 2, "organization", 3), // same pair → 5 total
        co(3, "individual", 2, "organization", 1),
      ],
      empty,
      empty
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      individualId: 1,
      organizationId: 2,
      sharedVisits: 5,
    });
    expect(out[1]).toMatchObject({
      individualId: 3,
      organizationId: 2,
      sharedVisits: 1,
    });
  });

  it("never re-suggests an already-linked pair", () => {
    const linked = new Set([affiliationPairKey(1, 2)]);
    const out = suggestAffiliations(
      [co(1, "individual", 2, "organization", 4)],
      linked,
      empty
    );
    expect(out).toHaveLength(0);
  });

  it("never re-suggests a declined pair (remembered forever)", () => {
    const declined = new Set([affiliationPairKey(1, 2)]);
    const out = suggestAffiliations(
      [co(1, "individual", 2, "organization", 4)],
      empty,
      declined
    );
    expect(out).toHaveLength(0);
  });

  it("structurally never suggests an individual↔individual edge", () => {
    const out = suggestAffiliations(
      [co(1, "individual", 3, "individual", 9)],
      empty,
      empty
    );
    expect(out).toHaveLength(0);
  });
});
