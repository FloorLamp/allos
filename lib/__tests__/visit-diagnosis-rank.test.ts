import { describe, expect, it } from "vitest";
import {
  decodeDiagnosisRanks,
  diagnosisRankBadge,
  encodeDiagnosisRanks,
  rankForDiagnosis,
} from "../visit-diagnosis-rank";

describe("diagnosisRankBadge", () => {
  it("names rank 1 primary, and rank 2 by its number", () => {
    expect(diagnosisRankBadge({ name: "Acute bronchitis", rank: 1 })).toBe(
      "Primary"
    );
    // NOT "Secondary". FHIR rank 2 means "second in this list"; "secondary" in a
    // diagnosis name means an etiology, and spending the clinical word on the
    // ordinal one is the conflation #2589's withdrawn attempts were built on.
    expect(diagnosisRankBadge({ name: "Anemia", rank: 2 })).toBe("#2");
  });

  it("falls back to the diagnosis-role label, and stays silent on an unknown code", () => {
    expect(diagnosisRankBadge({ name: "Anemia", use: ["dd"] })).toBe(
      "Discharge"
    );
    expect(diagnosisRankBadge({ name: "Anemia", use: ["cm"] })).toBe(
      "Comorbidity"
    );
    // A source's private code is not echoed into the UI as if it meant something.
    expect(
      diagnosisRankBadge({ name: "Anemia", use: ["zz-local"] })
    ).toBeNull();
    expect(diagnosisRankBadge({ name: "Anemia" })).toBeNull();
  });

  it("prefers the rank over the role when both are stated", () => {
    expect(diagnosisRankBadge({ name: "Anemia", rank: 1, use: ["ad"] })).toBe(
      "Primary"
    );
  });
});

describe("encode / decode", () => {
  it("round-trips what a source stated", () => {
    const json = encodeDiagnosisRanks([
      { name: "Acute bronchitis", rank: 1, use: ["dd"] },
    ]);
    expect(decodeDiagnosisRanks(json)).toEqual([
      { name: "Acute bronchitis", rank: 1, use: ["dd"] },
    ]);
  });

  it("stores nothing when nothing was stated", () => {
    // Every CDA-sourced, AI-extracted and hand-typed visit lands here: the column
    // stays NULL rather than holding a row that can only render nothing.
    expect(encodeDiagnosisRanks([])).toBeNull();
    expect(encodeDiagnosisRanks(undefined)).toBeNull();
    expect(encodeDiagnosisRanks([{ name: "Anemia" }])).toBeNull();
    expect(encodeDiagnosisRanks([{ name: "  ", rank: 1 }])).toBeNull();
  });

  it("drops a rank that is not a positive integer", () => {
    expect(encodeDiagnosisRanks([{ name: "Anemia", rank: 0 }])).toBeNull();
    expect(encodeDiagnosisRanks([{ name: "Anemia", rank: 1.5 }])).toBeNull();
  });

  it("answers no-ranks for a malformed or foreign payload instead of throwing", () => {
    // The column is read on every visit render, and the diagnoses text beside it
    // is user-editable, so a page must not be able to crash on it.
    expect(decodeDiagnosisRanks(null)).toEqual([]);
    expect(decodeDiagnosisRanks("")).toEqual([]);
    expect(decodeDiagnosisRanks("not json")).toEqual([]);
    expect(decodeDiagnosisRanks('{"name":"Anemia"}')).toEqual([]);
    expect(decodeDiagnosisRanks('[{"rank":1}]')).toEqual([]);
  });
});

describe("rankForDiagnosis", () => {
  const entries = [{ name: "Acute bronchitis", rank: 1 }];

  it("matches the stored name case-insensitively", () => {
    expect(rankForDiagnosis(entries, "acute BRONCHITIS")).toEqual(entries[0]);
  });

  it("finds nothing for a name the user has since edited", () => {
    // A stale entry is inert: it can only ever badge the exact name it was
    // captured for, so an edited diagnosis simply loses its badge.
    expect(rankForDiagnosis(entries, "Acute bronchitis, resolved")).toBeNull();
    expect(rankForDiagnosis([], "Acute bronchitis")).toBeNull();
  });
});
