import { describe, it, expect } from "vitest";
import {
  bandNoteClause,
  biomarkerValueBasis,
  REPORTED_RANGE_LABEL,
} from "@/lib/biomarker-value-basis";
import canonical from "@/lib/canonical-biomarkers.json";
import { flagTone } from "@/lib/reference-range";

// A COLOURED VALUE MUST BE ABLE TO POINT AT ITS BASIS (#2340).
//
// The biomarker detail page coloured its latest value from the stored flag while
// building its range display exclusively from the CURATED entry, so an analyte the
// catalog declines to band rendered red with no range on screen at all — while the
// range the flag actually came from sat unread on the row. These are the three states
// the issue decided, plus the clause that explains the missing band.
//
// PHI: no real values. Ranges here are invented for the fixture; the notes read are
// the repository's own curated dataset.

const NOTES = (canonical as { biomarkers: { name: string; note?: string }[] })
  .biomarkers;

function noteFor(name: string): string {
  const n = NOTES.find((b) => b.name === name)?.note;
  if (!n) throw new Error(`no curated note for ${name}`);
  return n;
}

describe("biomarkerValueBasis", () => {
  it("keeps the flag and claims no source range when the app's own band is on screen", () => {
    const basis = biomarkerValueBasis({
      flag: "high",
      hasCuratedBand: true,
      reportedRange: "3.5-5.1",
    });
    expect(basis.kind).toBe("curated");
    // The curated entries are the caller's own cards — this must not add a second,
    // competing range beside them.
    expect(basis.reportedEntry).toBeNull();
    expect(basis.displayFlag).toBe("high");
  });

  it("shows the source's own range, attributed, when the catalog publishes none", () => {
    const basis = biomarkerValueBasis({
      flag: "low",
      hasCuratedBand: false,
      reportedRange: "0.6-11.1 ng/mL",
    });
    expect(basis.kind).toBe("reported");
    expect(basis.reportedEntry).toEqual({
      label: REPORTED_RANGE_LABEL,
      range: "0.6-11.1 ng/mL",
    });
    // The flag now HAS a visible basis, so it keeps its colour.
    expect(basis.displayFlag).toBe("low");
  });

  it("attributes the range to the lab rather than to the app", () => {
    // Load-bearing wording: the app publishes no band for this analyte, and two
    // readings of it can carry different source ranges. The label must not read as
    // a population band the app endorses.
    expect(REPORTED_RANGE_LABEL).toBe("Reference range (as reported)");
  });

  it("treats a whitespace-only printed range as no range at all", () => {
    const basis = biomarkerValueBasis({
      flag: "high",
      hasCuratedBand: false,
      reportedRange: "   ",
    });
    expect(basis.kind).toBe("none");
    expect(basis.displayFlag).toBeNull();
  });

  it("does not colour a value with neither a curated band nor a source range", () => {
    for (const flag of [
      "high",
      "low",
      "abnormal",
      "non-optimal-high",
      "non-optimal-low",
      "non-optimal",
    ]) {
      const basis = biomarkerValueBasis({
        flag,
        hasCuratedBand: false,
        reportedRange: null,
      });
      expect(basis.kind).toBe("none");
      expect(basis.reportedEntry).toBeNull();
      // Null at the FLAG, not at the colour: this is what also removes the caret and
      // #2343's visible severity word, so the page cannot say "Low" with nothing to
      // point at.
      expect(basis.displayFlag).toBeNull();
      expect(flagTone(basis.displayFlag)).toBe("default");
    }
  });

  it("keeps a flag that colours nothing, so a basis-less page still says 'Immune'", () => {
    // "immune" is a non-normal flag but a NEUTRAL tone — it renders its own emerald
    // status, never an alarm. Suppressing it would delete an honest label rather than
    // an unsupported claim.
    const basis = biomarkerValueBasis({
      flag: "immune",
      hasCuratedBand: false,
      reportedRange: null,
    });
    expect(basis.kind).toBe("none");
    expect(basis.displayFlag).toBe("immune");
  });

  it("passes a normal or absent flag through untouched", () => {
    for (const flag of [null, undefined, "", "normal"]) {
      expect(
        biomarkerValueBasis({
          flag,
          hasCuratedBand: false,
          reportedRange: null,
        }).displayFlag
      ).toBe(flag ?? null);
    }
  });

  it("counts the value's own stated verdict as a basis", () => {
    // A positive infection screen is flagged `abnormal` against the qualitative
    // classifier, never against a range, and the word it was judged on IS the value
    // the surface renders. Decolouring it would hide a true positive to satisfy a
    // rule about ranges.
    const basis = biomarkerValueBasis({
      flag: "abnormal",
      hasCuratedBand: false,
      reportedRange: null,
      qualitative: true,
    });
    expect(basis.kind).toBe("qualitative");
    expect(basis.reportedEntry).toBeNull();
    expect(basis.displayFlag).toBe("abnormal");
  });

  it("prefers the curated band, then the source range, then the value's own verdict", () => {
    const both = biomarkerValueBasis({
      flag: "abnormal",
      hasCuratedBand: true,
      reportedRange: "Non-Reactive",
      qualitative: true,
    });
    expect(both.kind).toBe("curated");
    const printed = biomarkerValueBasis({
      flag: "abnormal",
      hasCuratedBand: false,
      reportedRange: "Non-Reactive",
      qualitative: true,
    });
    expect(printed.kind).toBe("reported");
  });
});

describe("bandNoteClause", () => {
  it("keeps only the clause that explains the missing band", () => {
    // Leptin is the issue's own case: the curated note's first clause is a
    // near-paraphrase of the explainer card's description, and only the second says
    // why there is no band.
    const clause = bandNoteClause(noteFor("Leptin"));
    expect(clause).toBe(
      "Levels track body-fat mass and are strongly sex- and BMI-dependent, so no single reference band applies."
    );
    // The duplicated half is exactly what does NOT travel.
    expect(clause).not.toContain("hormone made by fat tissue");
  });

  it("carries an explicit band table when one stands in for a reference range", () => {
    const clause = bandNoteClause(noteFor("PHQ-9"));
    expect(clause).toContain("Severity bands:");
    expect(clause).not.toContain("Public domain");
  });

  it("does not split a clause at an abbreviation or a citation year", () => {
    expect(bandNoteClause(noteFor("Grip Strength"))).toBe(
      "Interpreted by age/sex percentile (Dodds et al. 2014), not a fixed cutoff."
    );
  });

  it("ends a clause lifted at a semicolon as a sentence", () => {
    const clause = bandNoteClause(noteFor("Visual Acuity, Right Eye"));
    expect(clause).toBe("Qualitative — no numeric reference band.");
  });

  it("ignores 'band' used as a cell type rather than a reference band", () => {
    // "Immature (band) neutrophils …" is the description this change exists to stop
    // duplicating, not an explanation of a missing range.
    expect(bandNoteClause(noteFor("Band Neutrophils"))).toBeNull();
  });

  it("returns null for an absent, empty, or band-silent note", () => {
    expect(bandNoteClause(null)).toBeNull();
    expect(bandNoteClause(undefined)).toBeNull();
    expect(bandNoteClause("   ")).toBeNull();
    expect(bandNoteClause("A hormone released by fat tissue.")).toBeNull();
  });

  it("never returns a clause that starts mid-word or lower-case", () => {
    // Every curated note, so a dataset edit that produces an unreadable fragment
    // fails here rather than on the page.
    for (const b of NOTES) {
      const clause = bandNoteClause(b.note);
      if (clause == null) continue;
      expect(clause).toBe(clause.trim());
      expect(clause.charAt(0)).toBe(clause.charAt(0).toUpperCase());
      expect(clause.endsWith(";")).toBe(false);
    }
  });
});
