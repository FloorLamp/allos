import { describe, expect, it } from "vitest";
import {
  MEDICAL_CATEGORIES,
  RESULTS_CATALOG_CATEGORIES,
  MEDICAL_FLAGS,
  NON_IDENTITY_CATEGORIES,
  carriesResultIdentity,
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
