// PURE TIER — the lab result lifecycle (#1404): the status vocabulary, the tri-state
// fasting parse, and THE supersession decision every ingest path routes through.
//
// The decision is the load-bearing one: it separates a re-ISSUED result (a value the
// user already read, now changed — must be preserved before the overwrite) from an
// idempotent re-send of a rolling sync window (must stay a silent no-op, or every
// hourly sync would accumulate revision rows for readings nobody touched).

import { describe, expect, it } from "vitest";
import {
  fastingLabel,
  isCorrectionStatus,
  isResultStatus,
  normalizeResultStatus,
  parseFasting,
  RESULT_STATUSES,
  RESULT_STATUS_LABELS,
  resultStatusLabel,
  revisionSummary,
  sanitizeSpecimen,
  supersedesReading,
  type ReadingState,
} from "@/lib/lab-result-lifecycle";

const READING: ReadingState = {
  date: "2026-03-04",
  value: "5.2",
  value_num: 5.2,
  unit: "mmol/L",
  result_status: "final",
};

describe("the result-status vocabulary", () => {
  it("is the four FHIR result statuses, each with a label", () => {
    expect([...RESULT_STATUSES]).toEqual([
      "preliminary",
      "final",
      "corrected",
      "amended",
    ]);
    for (const s of RESULT_STATUSES)
      expect(RESULT_STATUS_LABELS[s].length).toBeGreaterThan(0);
  });

  it("normalizes only real statuses — an unknown word is UNSTATED, not 'final'", () => {
    expect(normalizeResultStatus("Corrected")).toBe("corrected");
    expect(normalizeResultStatus("  AMENDED ")).toBe("amended");
    // FHIR statuses that describe the request or a retraction, not the result.
    expect(normalizeResultStatus("registered")).toBeNull();
    expect(normalizeResultStatus("entered-in-error")).toBeNull();
    expect(normalizeResultStatus("unknown")).toBeNull();
    expect(normalizeResultStatus("")).toBeNull();
    expect(normalizeResultStatus(null)).toBeNull();
    expect(normalizeResultStatus(undefined)).toBeNull();
    expect(isResultStatus("final")).toBe(true);
    expect(isResultStatus("cancelled")).toBe(false);
  });

  it("names only the statuses that claim a re-issue as corrections", () => {
    expect(isCorrectionStatus("corrected")).toBe(true);
    expect(isCorrectionStatus("amended")).toBe(true);
    expect(isCorrectionStatus("final")).toBe(false);
    expect(isCorrectionStatus("preliminary")).toBe(false);
    expect(isCorrectionStatus(null)).toBe(false);
  });

  it("renders no label for an unstated status (never a misleading 'Final')", () => {
    expect(resultStatusLabel("corrected")).toBe("Corrected");
    expect(resultStatusLabel(null)).toBeNull();
    expect(resultStatusLabel("nonsense")).toBeNull();
  });
});

describe("fasting is a nullable TRI-STATE", () => {
  it("parses stated values and leaves anything else unstated", () => {
    expect(parseFasting(1)).toBe(1);
    expect(parseFasting("1")).toBe(1);
    expect(parseFasting("yes")).toBe(1);
    expect(parseFasting(0)).toBe(0);
    expect(parseFasting("no")).toBe(0);
    expect(parseFasting("non-fasting")).toBe(0);
    // The form's "—" option, an absent field, a junk value: all UNSTATED. Never a
    // guessed 0, which would assert a non-fasting draw the source never claimed.
    expect(parseFasting("")).toBeNull();
    expect(parseFasting(null)).toBeNull();
    expect(parseFasting(undefined)).toBeNull();
    expect(parseFasting("maybe")).toBeNull();
  });

  it("labels only a stated fasting state", () => {
    expect(fastingLabel(1)).toBe("Fasting");
    expect(fastingLabel(0)).toBe("Non-fasting");
    expect(fastingLabel(null)).toBeNull();
  });
});

describe("specimen sanitation", () => {
  it("trims, collapses and caps; blank is null", () => {
    expect(sanitizeSpecimen("  Serum  ")).toBe("Serum");
    expect(sanitizeSpecimen("Urine,\n 24-hour")).toBe("Urine, 24-hour");
    expect(sanitizeSpecimen("   ")).toBeNull();
    expect(sanitizeSpecimen(null)).toBeNull();
    expect(sanitizeSpecimen("x".repeat(200))?.length).toBe(60);
  });
});

describe("supersedesReading — the correction decision", () => {
  it("is FALSE for an identical re-send (the ordinary rolling-window sync)", () => {
    expect(supersedesReading(READING, { ...READING })).toBe(false);
    // Whitespace/NULL-vs-empty noise is not a re-issue either.
    expect(supersedesReading(READING, { ...READING, value: " 5.2 " })).toBe(
      false
    );
  });

  it("is TRUE when the reported result actually changed", () => {
    expect(
      supersedesReading(READING, { ...READING, value: "5.9", value_num: 5.9 })
    ).toBe(true);
    expect(supersedesReading(READING, { ...READING, unit: "mg/dL" })).toBe(
      true
    );
    expect(supersedesReading(READING, { ...READING, date: "2026-03-05" })).toBe(
      true
    );
    // A value that disappears is a change too (a numeric replaced by a comment).
    expect(
      supersedesReading(READING, { ...READING, value: null, value_num: null })
    ).toBe(true);
  });

  it("is TRUE when the source itself calls the incoming result a correction", () => {
    // Same number, but the lab re-issued it as corrected/amended: the user must be
    // able to see that it was re-stated after review.
    expect(
      supersedesReading(READING, { ...READING, result_status: "corrected" })
    ).toBe(true);
    expect(
      supersedesReading(READING, { ...READING, result_status: "amended" })
    ).toBe(true);
    // …but a re-send that keeps calling itself corrected is still just a re-send.
    expect(
      supersedesReading(
        { ...READING, result_status: "corrected" },
        { ...READING, result_status: "corrected" }
      )
    ).toBe(false);
  });

  it("is FALSE for a status the source merely stated for the first time", () => {
    // preliminary -> final is the ordinary lifecycle, not a re-issue of a value.
    expect(
      supersedesReading(
        { ...READING, result_status: null },
        { ...READING, result_status: "final" }
      )
    ).toBe(false);
  });
});

describe("revisionSummary", () => {
  it("names the prior value and what replaced it", () => {
    expect(
      revisionSummary({
        value: "5.2",
        value_num: 5.2,
        unit: "mmol/L",
        superseded_at: "2026-03-06 08:00:00",
        superseded_by_status: "corrected",
      })
    ).toBe("Corrected — was 5.2 mmol/L (2026-03-06)");
  });

  it("reads honestly when the re-issue stated no status", () => {
    expect(
      revisionSummary({
        value: null,
        value_num: 12,
        unit: null,
        superseded_at: "2026-03-06 08:00:00",
        superseded_by_status: null,
      })
    ).toBe("Superseded — was 12 (2026-03-06)");
  });
});
