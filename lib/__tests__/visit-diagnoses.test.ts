import { describe, it, expect } from "vitest";
import {
  joinVisitDiagnoses,
  normalizeVisitDiagnoses,
  normalizeVisitDiagnosisSummary,
  parseVisitDiagnosis,
  splitVisitDiagnosisSummary,
} from "../visit-diagnoses";

// The one rule the import seam, its diff mirror and both display splitters share
// (issue #2589): a source that bakes " - Primary" into a diagnosis display name may be
// stating a RANK rather than a second diagnosis — but only the rest of the summary can
// say whether it is, because "Primary" and "Secondary" are also clinical clauses.
describe("parseVisitDiagnosis — the CANDIDATE split, which decides nothing", () => {
  it("offers the base name a trailing rank qualifier would leave behind", () => {
    expect(parseVisitDiagnosis("Acute pharyngitis - Primary")).toEqual({
      name: "Acute pharyngitis",
      rank: "primary",
    });
    expect(parseVisitDiagnosis("Acute pharyngitis - Secondary")).toEqual({
      name: "Acute pharyngitis",
      rank: "secondary",
    });
  });

  it("recognizes the case and spacing variants a source may emit", () => {
    for (const raw of [
      "Asthma - primary",
      "Asthma - PRIMARY",
      "Asthma  -  Primary",
      "Asthma - Primary ",
    ]) {
      expect(parseVisitDiagnosis(raw)).toEqual({
        name: "Asthma",
        rank: "primary",
      });
    }
  });

  it("leaves a hyphenated clause outside the closed list alone", () => {
    for (const raw of [
      "Type 2 diabetes mellitus - uncontrolled",
      "Fracture of tibia - closed",
      "Otitis media - right ear",
      "Follow-up encounter",
      "Primary hypertension",
      "Encounter for primary care",
    ]) {
      expect(parseVisitDiagnosis(raw)).toEqual({ name: raw, rank: null });
    }
  });

  it("does not strip a qualifier that is not a spaced trailing suffix", () => {
    expect(parseVisitDiagnosis("Asthma-Primary")).toEqual({
      name: "Asthma-Primary",
      rank: null,
    });
    expect(parseVisitDiagnosis("Asthma - Primary care visit")).toEqual({
      name: "Asthma - Primary care visit",
      rank: null,
    });
  });

  it("keeps a bare qualifier verbatim rather than emptying it", () => {
    expect(parseVisitDiagnosis("- Primary")).toEqual({
      name: "- Primary",
      rank: null,
    });
  });
});

// The heart of #2589's correction. "Primary" and "Secondary" are among the most common
// clinical distinguishing clauses in diagnosis names, in the SAME "<name> - <clause>"
// shape as the rank. Stripping on the strength of the word alone collapses distinct
// diseases and deletes an etiology off a lone row, irreversibly, in a column that records
// the rank nowhere else. So the summary must carry the evidence.
describe("normalizeVisitDiagnoses — a qualifier is a rank only against evidence", () => {
  it("collapses the plain + qualified pair into one primary-first entry", () => {
    // The motivating CCD row: the plain twin is present, so "- Primary" is a rank.
    const long =
      "Encounter of male for testing for genetic disease carrier status for procreative management";
    expect(normalizeVisitDiagnoses([long, `${long} - Primary`])).toEqual([
      { name: long, rank: "primary" },
    ]);
  });

  it("keeps BOTH clinical variants when no plain twin evidences a rank", () => {
    // Primary and secondary hyperparathyroidism are different diseases with different
    // management — a parathyroid adenoma versus a response to renal failure. Collapsing
    // them to "Hyperparathyroidism" deletes the one fact that distinguishes them.
    for (const base of [
      "Hyperparathyroidism",
      "Amyloidosis",
      "Multiple sclerosis",
    ]) {
      expect(
        normalizeVisitDiagnoses([
          `${base} - Primary`,
          `${base} - Secondary`,
        ]).map((d) => d.name)
      ).toEqual([`${base} - Primary`, `${base} - Secondary`]);
    }
  });

  it("leaves a LONE qualified entry byte-identical — no duplicate, no rewrite", () => {
    // Secondary adrenal insufficiency is pituitary; primary is Addison's. There is no
    // duplicate here to fix, so there is nothing to do.
    expect(
      normalizeVisitDiagnoses(["Adrenal insufficiency - Secondary"])
    ).toEqual([{ name: "Adrenal insufficiency - Secondary", rank: null }]);
  });

  it("keeps the clinical variants even when the bare name is ALSO listed", () => {
    // A base wearing two DIFFERENT qualifiers is clinical whatever else is present: a
    // visit does not rank one finding both primary and secondary. Failing to dedup costs
    // a repeated chip; deduping wrongly costs a diagnosis.
    expect(
      normalizeVisitDiagnoses([
        "Amyloidosis",
        "Amyloidosis - Primary",
        "Amyloidosis - Secondary",
      ]).map((d) => d.name)
    ).toEqual([
      "Amyloidosis",
      "Amyloidosis - Primary",
      "Amyloidosis - Secondary",
    ]);
  });

  it("preserves source order when nothing was deduped", () => {
    // Order is source information. A summary the rule did not change must come back in
    // the order it arrived — "the algorithm sorts" is not a reason to reorder it.
    expect(
      normalizeVisitDiagnoses(["C", "B", "A - Primary", "D"]).map((d) => d.name)
    ).toEqual(["C", "B", "A - Primary", "D"]);
  });

  it("hoists a RECOVERED primary, which only happens where a collapse did", () => {
    expect(
      normalizeVisitDiagnoses([
        "Acute pharyngitis",
        "Essential hypertension",
        "Essential hypertension - Primary",
        "Seasonal allergic rhinitis",
      ]).map((d) => d.name)
    ).toEqual([
      "Essential hypertension",
      "Acute pharyngitis",
      "Seasonal allergic rhinitis",
    ]);
  });

  it("keeps two genuinely different diagnoses", () => {
    expect(
      normalizeVisitDiagnoses(["Acute pharyngitis", "Acute sinusitis"]).map(
        (d) => d.name
      )
    ).toEqual(["Acute pharyngitis", "Acute sinusitis"]);
  });

  it("dedups case-insensitively, keeping the source's FIRST spelling", () => {
    expect(
      normalizeVisitDiagnoses([
        "acute PHARYNGITIS",
        "Acute Pharyngitis - Primary",
      ])
    ).toEqual([{ name: "acute PHARYNGITIS", rank: "primary" }]);
  });

  it("takes the strongest rank when the plain twin meets repeated qualified copies", () => {
    // Reachable only for ONE distinct qualifier — two different ones are the clinical
    // case above and never collapse, so this tie-break can no longer lose an etiology.
    expect(
      normalizeVisitDiagnoses([
        "Acute pharyngitis",
        "Acute pharyngitis - Secondary",
        "Acute pharyngitis - secondary",
      ])
    ).toEqual([{ name: "Acute pharyngitis", rank: "secondary" }]);
  });

  it("still collapses a byte-equal repeat with no qualifier in sight", () => {
    expect(normalizeVisitDiagnoses(["Asthma", "Asthma"])).toEqual([
      { name: "Asthma", rank: null },
    ]);
  });

  it("drops blank entries", () => {
    expect(normalizeVisitDiagnoses(["", "   ", "Asthma"])).toEqual([
      { name: "Asthma", rank: null },
    ]);
  });
});

describe("joinVisitDiagnoses / summary round-trip", () => {
  it("joins the deduped list with the stored delimiter", () => {
    expect(
      joinVisitDiagnoses([
        "Acute pharyngitis",
        "Acute pharyngitis - Primary",
        "Acute sinusitis",
      ])
    ).toBe("Acute pharyngitis; Acute sinusitis");
  });

  it("is empty for no diagnoses", () => {
    expect(joinVisitDiagnoses([])).toBe("");
  });

  it("splits a stored summary back into its names", () => {
    expect(splitVisitDiagnosisSummary("A; B;C ; ")).toEqual(["A", "B", "C"]);
    expect(splitVisitDiagnosisSummary(null)).toEqual([]);
  });

  it("normalizes an already-stored summary, and is idempotent", () => {
    const stored = "Acute pharyngitis; Acute pharyngitis - Primary; Fever";
    const once = normalizeVisitDiagnosisSummary(stored);
    expect(once).toBe("Acute pharyngitis; Fever");
    expect(normalizeVisitDiagnosisSummary(once)).toBe(once);
  });

  // The repro set, as summaries — the shape the migration actually rewrites. Every one
  // of these must come back byte-identical, which makes the healing pass a no-op on them.
  it("leaves a summary with nothing to fix byte-identical", () => {
    for (const stored of [
      "Type 2 diabetes mellitus - uncontrolled; Acute sinusitis",
      "Hyperparathyroidism - Primary; Hyperparathyroidism - Secondary",
      "Amyloidosis - Primary; Amyloidosis - Secondary",
      "Multiple sclerosis - Primary; Multiple sclerosis - Secondary",
      "Adrenal insufficiency - Secondary",
      "C; B; A - Primary; D",
    ]) {
      expect(normalizeVisitDiagnosisSummary(stored)).toBe(stored);
    }
  });

  it("answers null for an empty summary", () => {
    expect(normalizeVisitDiagnosisSummary(null)).toBeNull();
    expect(normalizeVisitDiagnosisSummary("   ")).toBeNull();
  });
});
