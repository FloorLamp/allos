import { describe, it, expect } from "vitest";
import {
  careOfferBasis,
  RECHECK_BASIS_HEADING,
  RECHECK_BASIS_NOTE,
  RETEST_BASIS_NOTE,
} from "@/lib/biomarker-care-basis";
import type { ValueBasisKind } from "@/lib/biomarker-value-basis";
import { biomarkerValueBasis } from "@/lib/biomarker-value-basis";
import { isOutOfRange } from "@/lib/reference-range";

// A CARE OFFER ON A BASIS-LESS BIOMARKER NAMES ITS OWN BASIS (#2347).
//
// #2340 stopped the detail page colouring a value it cannot show a basis for. The two
// care offers beside that value kept reading the stored flag, so the page rendered a
// reading neutral and then offered a "Recheck" whose whole premise is that it is out
// of range. The ruling was option 3: keep the control, name its basis.

const BASES: ValueBasisKind[] = ["curated", "reported", "qualitative", "none"];
// `isOutOfRange` is high | low | abnormal; everything else (including the non-optimal
// tiers and `immune`) is not, which is exactly what gates `canTrackFollowUp`.
const OUT_OF_RANGE = ["high", "low", "abnormal"];
const IN_RANGE = [
  null,
  "normal",
  "non-optimal-high",
  "non-optimal-low",
  "immune",
];

describe("careOfferBasis — the recheck offer (#2347)", () => {
  it("names the source record as its basis only where the page shows no judgment", () => {
    for (const basis of BASES) {
      for (const flag of OUT_OF_RANGE) {
        const got = careOfferBasis("recheck", { basis, flag });
        if (basis === "none") {
          expect(got.premise).toBe("source-flag");
          expect(got.note).toBe(RECHECK_BASIS_NOTE);
        } else {
          expect(got.premise).toBe("displayed");
          expect(got.note).toBeNull();
        }
      }
    }
  });

  it("says nothing for a reading that carries no out-of-range flag, whatever its basis", () => {
    for (const basis of BASES) {
      for (const flag of IN_RANGE) {
        const got = careOfferBasis("recheck", { basis, flag });
        expect(got.premise).toBe("unflagged");
        expect(got.note).toBeNull();
      }
    }
  });

  it("agrees with the gate the page actually renders the offer on", () => {
    // The note may only appear where `canTrackFollowUp`'s own condition holds —
    // otherwise it would explain an offer that is not on screen.
    for (const basis of BASES) {
      for (const flag of [...OUT_OF_RANGE, ...IN_RANGE]) {
        const got = careOfferBasis("recheck", { basis, flag });
        if (got.note !== null) expect(isOutOfRange(flag)).toBe(true);
      }
    }
  });
});

describe("careOfferBasis — the retest notice (#2347 scope note)", () => {
  it("is premised on the reading's age for every basis and every flag", () => {
    for (const basis of BASES) {
      for (const flag of [...OUT_OF_RANGE, ...IN_RANGE]) {
        expect(careOfferBasis("retest", { basis, flag }).premise).toBe(
          "reading-age"
        );
      }
    }
  });

  it("names that age only where the page has declined to judge the value", () => {
    for (const basis of BASES) {
      for (const flag of [...OUT_OF_RANGE, ...IN_RANGE]) {
        const got = careOfferBasis("retest", { basis, flag });
        expect(got.note).toBe(basis === "none" ? RETEST_BASIS_NOTE : null);
      }
    }
  });
});

describe("the copy itself is the deliverable (#2347)", () => {
  const COPY = [RECHECK_BASIS_HEADING, RECHECK_BASIS_NOTE, RETEST_BASIS_NOTE];

  it("never re-asserts a severity the page just declined to claim", () => {
    // No direction word, in any of it: the recheck note attributes the flag to the
    // record without repeating what the record said.
    for (const text of COPY)
      expect(text).not.toMatch(
        /\b(high|low|elevated|abnormal|out of range|critical|severe)\b/i
      );
  });

  it("does not read as an error", () => {
    for (const text of COPY)
      expect(text).not.toMatch(
        /\b(error|failed|cannot|can't|unavailable|missing|unknown|problem|sorry)\b/i
      );
  });

  it("keeps the recheck note's attribution — the record's flag, not the app's", () => {
    expect(RECHECK_BASIS_NOTE).toContain("The record this reading came from");
    expect(RECHECK_BASIS_NOTE).toContain("not a judgment of ours");
    // And it explains the neutral value beside it rather than contradicting it.
    expect(RECHECK_BASIS_NOTE).toContain("renders neutral");
  });

  it("keeps the retest note about the age rather than the number", () => {
    expect(RETEST_BASIS_NOTE).toContain("the reading's age");
    expect(RETEST_BASIS_NOTE).toContain("not a judgment of the value above");
  });
});

describe("the two modules answer one question together (#2340 + #2347)", () => {
  it("the recheck note appears exactly where the value went neutral", () => {
    // The same reading, through both decisions: a colouring flag with nothing
    // displayable behind it loses its colour AND gains the note; give the same
    // reading the source's own printed range and both revert.
    const bandless = {
      flag: "low",
      hasCuratedBand: false,
      reportedRange: null,
    };
    const value = biomarkerValueBasis(bandless);
    expect(value.kind).toBe("none");
    expect(value.displayFlag).toBeNull();
    expect(
      careOfferBasis("recheck", { basis: value.kind, flag: bandless.flag }).note
    ).toBe(RECHECK_BASIS_NOTE);

    const printed = biomarkerValueBasis({
      ...bandless,
      reportedRange: "3.0-15.0 ng/mL",
    });
    expect(printed.kind).toBe("reported");
    expect(printed.displayFlag).toBe("low");
    expect(
      careOfferBasis("recheck", { basis: printed.kind, flag: bandless.flag })
        .note
    ).toBeNull();
  });
});
