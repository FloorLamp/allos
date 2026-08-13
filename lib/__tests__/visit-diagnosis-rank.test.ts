import { describe, expect, it } from "vitest";
import {
  MAX_DIAGNOSIS_RANK,
  decodeDiagnosisRanks,
  diagnosisRankBadge,
  encodeDiagnosisRanks,
  rankForDiagnosis,
  spokenDiagnosis,
  spokenDiagnosisList,
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

  it("names the diagnosis-role labels, and stays silent on an unknown code", () => {
    expect(diagnosisRankBadge({ name: "Anemia", use: ["dd"] })).toBe(
      "Discharge"
    );
    expect(diagnosisRankBadge({ name: "Anemia", use: ["cm"] })).toBe(
      "Comorbidity"
    );
    // Every KNOWN role, not just the first — showing one of two dropped a fact the
    // source stated, and this is the exact shape the withheld-rank case renders in
    // (`{ use: ["ad", "dd"] }`, the per-role disagreement of #2589).
    expect(diagnosisRankBadge({ name: "Anemia", use: ["ad", "dd"] })).toBe(
      "Admission, Discharge"
    );
    // A source's private code is not echoed into the UI as if it meant something,
    // and dropping it leaves no dangling separator beside the codes that are known.
    expect(
      diagnosisRankBadge({ name: "Anemia", use: ["zz-local"] })
    ).toBeNull();
    expect(
      diagnosisRankBadge({ name: "Anemia", use: ["zz-local", "dd"] })
    ).toBe("Discharge");
    expect(diagnosisRankBadge({ name: "Anemia" })).toBeNull();
  });

  it("refuses a rank past the stated-ranking bound", () => {
    // `Number.isInteger(1e21)` is true and positiveInt has no upper bound on the
    // wire, so without this a malformed source badges a diagnosis "#1e+21".
    expect(diagnosisRankBadge({ name: "Anemia", rank: 1e21 })).toBeNull();
    expect(
      diagnosisRankBadge({ name: "Anemia", rank: MAX_DIAGNOSIS_RANK + 1 })
    ).toBeNull();
    expect(
      diagnosisRankBadge({ name: "Anemia", rank: MAX_DIAGNOSIS_RANK })
    ).toBe(`#${MAX_DIAGNOSIS_RANK}`);
    // Dropped rather than clamped — a clamp would invent a rank nobody wrote.
    expect(encodeDiagnosisRanks([{ name: "Anemia", rank: 1e21 }])).toBeNull();
    expect(decodeDiagnosisRanks('[{"name":"Anemia","rank":1e21}]')).toEqual([]);
  });

  it("qualifies a rank with the role the source scoped it to (#2589)", () => {
    // R4 defines rank "for each role type", so rank 1 stated under the discharge
    // role is primary-AT-DISCHARGE. Returning on the rank and never reaching the
    // roles rendered that as a bare "Primary" — the same unqualified cross-role
    // claim `encounterDiagnoses` withholds a rank to avoid, reached from the other
    // side, and it dropped the role from the card as well. Two conditions in one
    // visit, one ranked 1 at admission and one ranked 1 at discharge, then both
    // read "Primary" with nothing to tell a reader why.
    expect(diagnosisRankBadge({ name: "Anemia", rank: 1, use: ["ad"] })).toBe(
      "Primary, Admission"
    );
    expect(diagnosisRankBadge({ name: "Anemia", rank: 1, use: ["dd"] })).toBe(
      "Primary, Discharge"
    );
    expect(diagnosisRankBadge({ name: "Anemia", rank: 2, use: ["ad"] })).toBe(
      "#2, Admission"
    );
    // A rank the source scoped to NO role stays unqualified: there is nothing to
    // name, and appending a scope the source did not state would be the guess.
    expect(diagnosisRankBadge({ name: "Anemia", rank: 1 })).toBe("Primary");
    // Rank with only an unknown role code degrades to the rank alone.
    expect(
      diagnosisRankBadge({ name: "Anemia", rank: 1, use: ["zz-local"] })
    ).toBe("Primary");
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

describe("spokenDiagnosis", () => {
  const entries = [
    { name: "Acute bronchitis", rank: 1 },
    { name: "Anemia", use: ["cm"] },
  ];

  it("carries the source-stated rank into the accessible text", () => {
    // The grouped chip hides its visual pieces from assistive technology and
    // speaks these strings instead. A badge that lived only in the visual half
    // would be readable by sighted users and invisible to everyone else — half 2
    // deleting half 1's entire output from the accessibility tree.
    expect(spokenDiagnosis("Acute bronchitis", entries)).toBe(
      "Acute bronchitis (Primary)"
    );
    expect(spokenDiagnosis("Anemia", entries)).toBe("Anemia (Comorbidity)");
  });

  it("speaks the role qualifier too, so the visual and accessible claims match", () => {
    // The badge is comma-joined rather than glyph-joined precisely so this string
    // reads: a comma is a pause to a screen reader, a separator glyph is noise.
    expect(
      spokenDiagnosis("Anemia", [{ name: "Anemia", rank: 1, use: ["dd"] }])
    ).toBe("Anemia (Primary, Discharge)");
  });

  it("speaks a rankless diagnosis as its bare name", () => {
    expect(spokenDiagnosis("Hyperparathyroidism - Secondary", entries)).toBe(
      "Hyperparathyroidism - Secondary"
    );
    expect(spokenDiagnosis("Acute bronchitis", [])).toBe("Acute bronchitis");
  });
});

describe("spokenDiagnosisList — the whole accessible text of a factored chip", () => {
  const entries = [
    { name: "Acute bronchitis", rank: 1 },
    { name: "Essential hypertension", rank: 2 },
  ];

  it("composes every member's name with the rank the source stated", () => {
    // This is the string the grouped chip's sr-only span and title render. It
    // lives here rather than in the component because the repo keeps no component
    // tier (docs/internals/component-tests.md), so a regression to names-only —
    // the exact R2 defect — has to be catchable in the pure tier.
    expect(
      spokenDiagnosisList(
        ["Acute bronchitis", "Essential hypertension", "Anemia"],
        entries
      )
    ).toEqual([
      "Acute bronchitis (Primary)",
      "Essential hypertension (#2)",
      "Anemia",
    ]);
  });

  it("keeps the members in the order given", () => {
    expect(
      spokenDiagnosisList(
        ["Essential hypertension", "Acute bronchitis"],
        entries
      )
    ).toEqual(["Essential hypertension (#2)", "Acute bronchitis (Primary)"]);
  });
});
