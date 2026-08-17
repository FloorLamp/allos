import { describe, expect, it } from "vitest";
import {
  MEDICAL_CATEGORIES,
  RESULTS_CATALOG_CATEGORIES,
  MEDICAL_FLAGS,
  NON_IDENTITY_CATEGORIES,
  SCREENING_RESULT_CATEGORIES,
  carriesResultIdentity,
  categorySatisfiesScreening,
} from "@/lib/medical-categories";

describe("medical-categories: single source of truth", () => {
  it("MEDICAL_CATEGORIES is the full record enum", () => {
    expect([...MEDICAL_CATEGORIES]).toEqual([
      "vitals",
      "lab",
      "genomics",
      "scan",
      "prescription",
      // #1076 non-lab analyte classes split out of the old "has a range" bucket.
      "instrument",
      "derived",
      "reference",
      // #708 narrative diagnostic reports (micro/path report bodies).
      "report",
      // #2318 non-measurement assessments and qualifiers from a CCD.
      "assessment",
    ]);
  });

  it("RESULTS_CATALOG_CATEGORIES is the flat-catalog browsable set (#1076)", () => {
    // The flat Results catalog (/results/clinical-results) lists `lab` + the
    // out-of-scope `genomics`/`scan` stores, and KEEPS `vitals` (the domain vitals —
    // audiogram/IOP/acuity — have no dedicated chart home, so removing them would
    // strand them). The re-homed classes with a home — instruments, derived bio-age,
    // immutable facts — are excluded.
    expect([...RESULTS_CATALOG_CATEGORIES]).toEqual([
      "lab",
      "vitals",
      "genomics",
      "scan",
    ]);
    for (const excluded of [
      "prescription",
      "instrument",
      "derived",
      "reference",
      "assessment",
    ]) {
      expect(RESULTS_CATALOG_CATEGORIES as readonly string[]).not.toContain(
        excluded
      );
    }
  });

  it("NON_IDENTITY_CATEGORIES withholds result identity, and only from `assessment` (#2318)", () => {
    expect([...NON_IDENTITY_CATEGORIES]).toEqual(["assessment"]);
    // Every entry must be a real category, and none may be a catalog-browsable
    // class — withholding identity from something the catalog lists would be a
    // contradiction, not a policy.
    for (const c of NON_IDENTITY_CATEGORIES) {
      expect(MEDICAL_CATEGORIES as readonly string[]).toContain(c);
      expect(RESULTS_CATALOG_CATEGORIES as readonly string[]).not.toContain(c);
      expect(carriesResultIdentity(c)).toBe(false);
    }
    // Everything else DOES carry an identity — including `report`, whose exclusion
    // from the flat catalog is a different (weaker) statement.
    for (const c of MEDICAL_CATEGORIES) {
      if ((NON_IDENTITY_CATEGORIES as readonly string[]).includes(c)) continue;
      expect(carriesResultIdentity(c), c).toBe(true);
    }
  });

  it("SCREENING_RESULT_CATEGORIES classifies EVERY category, with a reason on both sides (#3025)", () => {
    // The guard the allowlist never had. An allowlist only ever wrote down one side, so
    // `report` — where a CCDA files its cytology reads — was neither admitted nor ruled
    // out, and it was dropped in silence. Every enum member must now carry a RULING and
    // a non-empty reason, in both directions.
    for (const c of MEDICAL_CATEGORIES) {
      const ruling = SCREENING_RESULT_CATEGORIES[c];
      expect(ruling, c).toBeDefined();
      expect(typeof ruling.admits, c).toBe("boolean");
      expect(ruling.why.trim().length, c).toBeGreaterThan(20);
      expect(categorySatisfiesScreening(c), c).toBe(ruling.admits);
    }
    // And the table holds nothing that is not a category.
    for (const key of Object.keys(SCREENING_RESULT_CATEGORIES)) {
      expect(MEDICAL_CATEGORIES as readonly string[], key).toContain(key);
    }
  });

  it("a screening result is admitted unless it was ruled out — the denylist (#3025)", () => {
    // ADMITTED. `report` is the #3025 case: a valueless narrative cytology read is the
    // only proof of a Pap there is, and the qualitative bridge cannot judge it.
    for (const c of ["lab", "vitals", "instrument", "report"]) {
      expect(categorySatisfiesScreening(c), c).toBe(true);
    }
    // RULED OUT, each for a reason about what the row IS.
    for (const c of [
      "genomics",
      "scan",
      "prescription",
      "derived",
      "reference",
      "assessment",
    ]) {
      expect(categorySatisfiesScreening(c), c).toBe(false);
    }
    // NULL is not a category: the legacy uncategorized residue (#2877) stays excluded.
    expect(categorySatisfiesScreening(null)).toBe(false);
    expect(categorySatisfiesScreening(undefined)).toBe(false);
    // WHAT IS DELIBERATELY NOT ASSERTED HERE: that an unknown category STRING is
    // admitted. It cannot be exercised by anything stored — `medical_records.category`
    // carries a CHECK constraint and migration 20260814-medical-category-residue rebuilt
    // the table without the retired `biomarker` bucket, mapping those rows to NULL. The
    // protection is the TYPE exhaustiveness pinned by the test above; the runtime
    // fallback is belt-and-braces over an argument type, not a property of the data.
  });

  it("nothing that is denied a result identity may satisfy a screening (#2318/#3025)", () => {
    // The two axes are independent, but this direction is not free to differ: a row the
    // app refuses to let claim a result at all cannot be the RESULT of a screening.
    for (const c of NON_IDENTITY_CATEGORIES) {
      expect(categorySatisfiesScreening(c), c).toBe(false);
    }
  });

  it("MEDICAL_FLAGS is the clinical subset, excluding the derived non-optimal flags", () => {
    expect([...MEDICAL_FLAGS]).toEqual(["normal", "high", "low", "abnormal"]);
    // The "non-optimal*" variants are reconciled in code from the canonical
    // optimal band and must never be model-emitted / user-accepted.
    for (const derived of [
      "non-optimal",
      "non-optimal-high",
      "non-optimal-low",
    ]) {
      expect(MEDICAL_FLAGS as readonly string[]).not.toContain(derived);
    }
  });
});
