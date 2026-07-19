import { describe, expect, it } from "vitest";
import {
  DOSE_WINDOW_YEARS,
  estimateStudyDose,
  resolveDoseEntry,
  cumulativeDose,
  combinedMsv,
  isCombinedEstimated,
  backgroundEquivalentMonths,
  windowStartDate,
  formatMsv,
  doseFramingNote,
  type DoseStudyInput,
} from "@/lib/radiation-dose";

// Pure-tier tests for cumulative radiation-dose tracking (#703): the estimate-vs-
// recorded resolution, the trailing-window boundary, and the SEPARATE-sums mixing
// policy. No DB — the estimator/cumulative read plain study fixtures.

function study(over: Partial<DoseStudyInput>): DoseStudyInput {
  return {
    modality: over.modality ?? "ct",
    body_region: over.body_region ?? null,
    dose_msv: over.dose_msv ?? null,
    study_date: over.study_date ?? null,
  };
}

describe("resolveDoseEntry — modality + region matching", () => {
  it("picks the most specific region entry for a modality", () => {
    expect(resolveDoseEntry("ct", "Abdomen/Pelvis")?.key).toBe(
      "ct-abdomen-pelvis"
    );
    expect(resolveDoseEntry("ct", "Chest")?.key).toBe("ct-chest");
    expect(resolveDoseEntry("ct", "Head")?.key).toBe("ct-head");
    expect(resolveDoseEntry("x-ray", "Chest")?.key).toBe("xray-chest");
    expect(resolveDoseEntry("x-ray", "Left Knee")?.key).toBe("xray-extremity");
  });

  it("falls back to the modality's generic entry when no region matches", () => {
    expect(resolveDoseEntry("ct", "Some Unmapped Region")?.key).toBe(
      "ct-generic"
    );
    expect(resolveDoseEntry("x-ray", null)?.key).toBe("xray-generic");
  });

  it("returns null for an unclassified 'other' modality (never a guess)", () => {
    expect(resolveDoseEntry("other", "Whole body")).toBeNull();
  });
});

describe("estimateStudyDose — recorded vs estimate vs none", () => {
  it("a recorded dose always wins and is marked 'recorded'", () => {
    const d = estimateStudyDose(study({ modality: "ct", dose_msv: 12.5 }));
    expect(d).toEqual({
      msv: 12.5,
      source: "recorded",
      entryKey: null,
      label: null,
    });
  });

  it("no recorded dose → the typical estimate, marked 'estimate'", () => {
    const d = estimateStudyDose(
      study({ modality: "ct", body_region: "Abdomen/Pelvis" })
    );
    expect(d.source).toBe("estimate");
    expect(d.entryKey).toBe("ct-abdomen-pelvis");
    expect(d.msv).toBe(10);
  });

  it("non-ionizing modalities resolve to a 0-mSv estimate", () => {
    expect(estimateStudyDose(study({ modality: "mri" })).msv).toBe(0);
    expect(estimateStudyDose(study({ modality: "ultrasound" })).msv).toBe(0);
  });

  it("an 'other' study yields source 'none' and 0 mSv (no fabricated number)", () => {
    const d = estimateStudyDose(study({ modality: "other" }));
    expect(d.source).toBe("none");
    expect(d.msv).toBe(0);
  });

  it("a negative / non-finite recorded value degrades to the estimate", () => {
    const d = estimateStudyDose(
      study({ modality: "x-ray", body_region: "Chest", dose_msv: -5 })
    );
    expect(d.source).toBe("estimate");
    expect(d.msv).toBe(0.1);
  });
});

describe("windowStartDate — trailing N-year calendar anchor", () => {
  it("subtracts whole years, keeping month/day", () => {
    expect(windowStartDate("2026-07-19", 3)).toBe("2023-07-19");
  });

  it("clamps a Feb-29 anchor to Feb-28 in a non-leap target year", () => {
    expect(windowStartDate("2024-02-29", 3)).toBe("2021-02-28");
  });
});

describe("cumulativeDose — window boundary", () => {
  const now = "2026-07-19";
  const since = windowStartDate(now, DOSE_WINDOW_YEARS); // 2023-07-19

  it("includes a study dated exactly on the window start (inclusive)", () => {
    const cum = cumulativeDose(
      [study({ modality: "ct", body_region: "Chest", study_date: since })],
      now
    );
    expect(cum.studiesInWindow).toBe(1);
    expect(cum.estimatedMsv).toBe(7);
  });

  it("excludes a study dated one day before the window start", () => {
    const cum = cumulativeDose(
      [
        study({
          modality: "ct",
          body_region: "Chest",
          study_date: "2023-07-18",
        }),
      ],
      now
    );
    expect(cum.studiesInWindow).toBe(0);
    expect(cum.hasAnyDose).toBe(false);
  });

  it("excludes a study with no date (can't be placed in the window)", () => {
    const cum = cumulativeDose(
      [study({ modality: "ct", body_region: "Chest", study_date: null })],
      now
    );
    expect(cum.studiesInWindow).toBe(0);
  });
});

describe("cumulativeDose — recorded and estimated sums stay SEPARATE", () => {
  const now = "2026-07-19";

  it("keeps recorded and estimated totals apart and never double-counts", () => {
    const cum = cumulativeDose(
      [
        // recorded
        study({ modality: "ct", dose_msv: 9, study_date: "2025-01-01" }),
        // estimated (abdomen/pelvis CT → 10)
        study({
          modality: "ct",
          body_region: "Abdomen/Pelvis",
          study_date: "2024-03-01",
        }),
        // non-ionizing → contributes nothing, not counted as an estimate
        study({ modality: "mri", study_date: "2024-06-01" }),
        // 'other' → contributes nothing
        study({ modality: "other", study_date: "2024-07-01" }),
      ],
      now
    );
    expect(cum.recordedMsv).toBe(9);
    expect(cum.recordedCount).toBe(1);
    expect(cum.estimatedMsv).toBe(10);
    expect(cum.estimatedCount).toBe(1);
    expect(cum.studiesInWindow).toBe(4);
    // The combined figure is derived, labeled as an estimate because an estimate is present.
    expect(combinedMsv(cum)).toBe(19);
    expect(isCombinedEstimated(cum)).toBe(true);
  });

  it("marks the combined figure NOT-estimated when every dose is recorded", () => {
    const cum = cumulativeDose(
      [
        study({ modality: "ct", dose_msv: 8, study_date: "2025-01-01" }),
        study({ modality: "x-ray", dose_msv: 0.1, study_date: "2025-02-01" }),
      ],
      now
    );
    expect(cum.estimatedCount).toBe(0);
    expect(isCombinedEstimated(cum)).toBe(false);
    expect(combinedMsv(cum)).toBe(8.1);
  });

  it("an MRI/ultrasound-only record has no dose to show (hasAnyDose false)", () => {
    const cum = cumulativeDose(
      [
        study({ modality: "mri", study_date: "2025-01-01" }),
        study({ modality: "ultrasound", study_date: "2025-02-01" }),
      ],
      now
    );
    expect(cum.hasAnyDose).toBe(false);
  });
});

describe("backgroundEquivalentMonths + formatMsv", () => {
  const now = "2026-07-19";

  it("expresses the combined dose as whole months of ~3 mSv/yr background", () => {
    const cum = cumulativeDose(
      [study({ modality: "ct", dose_msv: 3, study_date: "2025-01-01" })],
      now
    );
    // 3 mSv / (3 mSv/yr ÷ 12) = 12 months.
    expect(backgroundEquivalentMonths(cum)).toBe(12);
  });

  it("returns null when there is no dose to compare", () => {
    const cum = cumulativeDose([], now);
    expect(backgroundEquivalentMonths(cum)).toBeNull();
  });

  it("keeps small doses legible instead of rounding to 0", () => {
    expect(formatMsv(0.1)).toBe("0.1 mSv");
    expect(formatMsv(0.001)).toBe("0.001 mSv");
    expect(formatMsv(0)).toBe("0 mSv");
    expect(formatMsv(10)).toBe("10 mSv");
    expect(formatMsv(12.5)).toBe("12.5 mSv");
  });
});

describe("doseFramingNote — calm, and pediatric-aware", () => {
  it("is never alarmist (no 'too much' / limit-exceeded language)", () => {
    for (const note of [doseFramingNote(false), doseFramingNote(true)]) {
      expect(note.toLowerCase()).not.toContain("too much");
      expect(note).toContain("Informational, not medical advice.");
    }
  });

  it("carries pediatric framing for a child profile", () => {
    expect(doseFramingNote(true).toLowerCase()).toContain("children");
    expect(doseFramingNote(false).toLowerCase()).not.toContain("children");
  });
});
