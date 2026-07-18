import { describe, it, expect } from "vitest";
import {
  labBiomarkerName,
  labValueLabel,
  labsSourceLabel,
  labsFollowUpTitle,
  labsResolvingLabel,
  sameBiomarkerFamily,
  findResolvingLabResult,
  type LabFollowUpRecord,
} from "@/lib/followup-labs";
import type { FollowUpItemLike } from "@/lib/followup";

// The FLAGGED-LABS adapter boundaries (issue #700), the labs sibling of the imaging
// adapter's pure tests. Pins the domain answers the domain-agnostic core consumes:
// the #482 family matching for source/resolution (A1c ↔ eAG collapse, cross-analyte
// stays apart), the "for the flagged 8.2% (2026-05)" legibility label, the "Recheck …"
// title, and the "most-recent later reading of the same family" resolution rule.

function rec(over: Partial<LabFollowUpRecord> & { id: number }): LabFollowUpRecord {
  return {
    id: over.id,
    date: over.date ?? "2026-05-12",
    canonical_name: over.canonical_name ?? null,
    name: over.name ?? "Hemoglobin A1c",
    // Respect an explicit null (a numeric-only reading), only defaulting when omitted.
    value: over.value === undefined ? "8.2" : over.value,
    unit: over.unit ?? "%",
    value_num: over.value_num === undefined ? 8.2 : over.value_num,
    flag: over.flag ?? "high",
  };
}

const followUp: FollowUpItemLike = {
  id: 7,
  title: "Recheck Hemoglobin A1c",
  plannedDate: "2026-08-12",
  recommendedIntervalDays: 91,
  source: { kind: "labs", recordId: 1 },
  resolution: null,
};

describe("labs adapter — identity + labels", () => {
  it("labBiomarkerName prefers the canonical name, falls back to the raw name", () => {
    expect(labBiomarkerName(rec({ id: 1, canonical_name: "Hemoglobin A1c" }))).toBe(
      "Hemoglobin A1c"
    );
    expect(
      labBiomarkerName(rec({ id: 1, canonical_name: "  ", name: "HbA1c" }))
    ).toBe("HbA1c");
  });

  it("labValueLabel composes value + unit compactly ('%' glued, others spaced)", () => {
    expect(labValueLabel(rec({ id: 1, value: "8.2", unit: "%" }))).toBe("8.2%");
    expect(
      labValueLabel(rec({ id: 1, value: "142", unit: "mg/dL" }))
    ).toBe("142 mg/dL");
    // Numeric-only reading (value string null) falls back to value_num.
    expect(
      labValueLabel(rec({ id: 1, value: null, value_num: 5.4, unit: "%" }))
    ).toBe("5.4%");
  });

  it("labsSourceLabel names the FLAGGED value + reading month (the #656 reason tail)", () => {
    const label = labsSourceLabel(
      rec({ id: 1, value: "8.2", unit: "%", date: "2026-05-12" })
    );
    expect(label).toBe("flagged 8.2% (2026-05)");
  });

  it("labsFollowUpTitle is 'Recheck <biomarker>'", () => {
    expect(
      labsFollowUpTitle(rec({ id: 1, canonical_name: "Hemoglobin A1c" }))
    ).toBe("Recheck Hemoglobin A1c");
    expect(
      labsFollowUpTitle(rec({ id: 1, canonical_name: "LDL Cholesterol" }))
    ).toBe("Recheck LDL Cholesterol");
  });

  it("labsResolvingLabel is compact + dated", () => {
    expect(
      labsResolvingLabel(
        rec({ id: 2, value: "5.4", unit: "%", date: "2026-08-20" })
      )
    ).toBe("5.4% · 2026-08");
  });
});

describe("labs adapter — #482 family matching", () => {
  it("A1c and its eAG re-expression are the SAME family (one measurement, two names)", () => {
    const a1c = rec({ id: 1, canonical_name: "Hemoglobin A1c" });
    const eag = rec({
      id: 2,
      canonical_name: "Estimated Average Glucose",
      value: "126",
      unit: "mg/dL",
      value_num: 126,
    });
    expect(sameBiomarkerFamily(a1c, eag)).toBe(true);
  });

  it("distinct analytes stay APART (A1c never resolves an LDL follow-up)", () => {
    const a1c = rec({ id: 1, canonical_name: "Hemoglobin A1c" });
    const ldl = rec({ id: 2, canonical_name: "LDL Cholesterol" });
    expect(sameBiomarkerFamily(a1c, ldl)).toBe(false);
    // A bare fasting glucose is NOT the A1c family (the eAG qualifier is what identifies it).
    const glucose = rec({ id: 3, canonical_name: "Glucose" });
    expect(sameBiomarkerFamily(a1c, glucose)).toBe(false);
  });
});

describe("labs adapter — resolution matching", () => {
  it("resolves against a LATER same-family reading; the eAG recheck resolves an A1c", () => {
    const source = rec({
      id: 1,
      canonical_name: "Hemoglobin A1c",
      date: "2026-05-12",
    });
    const laterEag = rec({
      id: 2,
      canonical_name: "Estimated Average Glucose",
      date: "2026-08-20",
      value: "114",
      unit: "mg/dL",
      value_num: 114,
    });
    const laterLdl = rec({
      id: 3,
      canonical_name: "LDL Cholesterol",
      date: "2026-09-01",
    });
    const earlierA1c = rec({ id: 4, date: "2026-01-01" });
    const candidates = [source, laterEag, laterLdl, earlierA1c];
    expect(
      findResolvingLabResult(source, followUp, candidates)?.id
    ).toBe(2); // the later eAG (same family), not the LDL, not the earlier A1c
  });

  it("returns null when only earlier or the source itself is present", () => {
    const source = rec({ id: 1, date: "2026-05-12" });
    expect(findResolvingLabResult(source, followUp, [source])).toBeNull();
    const earlier = rec({ id: 2, date: "2026-01-01" });
    expect(
      findResolvingLabResult(source, followUp, [source, earlier])
    ).toBeNull();
  });

  it("picks the MOST RECENT qualifying later reading", () => {
    const source = rec({ id: 1, date: "2026-01-01" });
    const a = rec({ id: 2, date: "2026-06-01" });
    const b = rec({ id: 3, date: "2027-06-01" });
    expect(
      findResolvingLabResult(source, followUp, [source, a, b])?.id
    ).toBe(3);
  });
});
