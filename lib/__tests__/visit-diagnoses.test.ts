import { describe, it, expect } from "vitest";
import {
  joinVisitDiagnoses,
  normalizeVisitDiagnoses,
  normalizeVisitDiagnosisSummary,
  parseVisitDiagnosis,
  splitVisitDiagnosisSummary,
} from "../visit-diagnoses";

// The one rule the import seam, its diff mirror and the healing migration share
// (issue #2589): a source that bakes " - Primary" into a diagnosis display name is
// stating a RANK, not a second diagnosis.
describe("parseVisitDiagnosis — the closed rank-qualifier list", () => {
  it("reads a trailing rank qualifier off the name", () => {
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

  it("leaves a hyphenated clause that is NOT a rank qualifier alone", () => {
    // The whole reason the list is closed: these clauses carry the distinction the
    // name exists to draw, and a general trailing-hyphen guess would eat them.
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

describe("normalizeVisitDiagnoses", () => {
  it("collapses the plain + qualified pair into one primary-first entry", () => {
    const long =
      "Encounter of male for testing for genetic disease carrier status for procreative management";
    expect(normalizeVisitDiagnoses([long, `${long} - Primary`])).toEqual([
      { name: long, rank: "primary" },
    ]);
  });

  it("orders the primary diagnosis ahead of the rest, keeping source order otherwise", () => {
    expect(
      normalizeVisitDiagnoses([
        "Acute pharyngitis",
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

  it("dedups case-insensitively, keeping the first spelling and the strongest rank", () => {
    expect(
      normalizeVisitDiagnoses([
        "Acute pharyngitis - Secondary",
        "acute PHARYNGITIS - Primary",
      ])
    ).toEqual([{ name: "Acute pharyngitis", rank: "primary" }]);
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

  it("leaves a summary with nothing to fix byte-identical", () => {
    const stored = "Type 2 diabetes mellitus - uncontrolled; Acute sinusitis";
    expect(normalizeVisitDiagnosisSummary(stored)).toBe(stored);
  });

  it("answers null for an empty summary", () => {
    expect(normalizeVisitDiagnosisSummary(null)).toBeNull();
    expect(normalizeVisitDiagnosisSummary("   ")).toBeNull();
  });
});
