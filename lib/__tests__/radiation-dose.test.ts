import { describe, expect, it } from "vitest";
import {
  DOSE_WINDOW_YEARS,
  estimateStudyDose,
  resolveDoseEntry,
  cumulativeDose,
  combinedMsv,
  isCombinedEstimated,
  backgroundEquivalentMonths,
  backgroundEquivalentLabel,
  windowStartDate,
  formatMsv,
  doseFramingNote,
  doseContributions,
  doseChipLabel,
  doseSourceNote,
  doseExclusionNote,
  type DoseStudyInput,
  type DoseExclusionReason,
} from "@/lib/radiation-dose";

// Pure-tier tests for cumulative radiation-dose tracking (#703): the estimate-vs-
// recorded resolution, the trailing-window boundary, and the SEPARATE-sums mixing
// policy. No DB — the estimator/cumulative read plain study fixtures.
//
// #2970 adds the second half: the total can NAME the studies behind it and the ones it
// left out, and the trailing window is a secondary lens instead of the headline's
// arithmetic. The four cases below come from the 2026-08-15 snapshot audit that filed
// the issue — a repeated mammogram, an undated X-ray, an unclassified study, and an
// ultrasound — because each is a class of silence the breakdown exists to end.

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

  it("resolves the high-dose modalities added in #1034 (region-specific + generic)", () => {
    expect(resolveDoseEntry("pet", "Whole body")?.key).toBe("pet-wholebody");
    expect(resolveDoseEntry("pet", null)?.key).toBe("pet-wholebody");
    expect(
      resolveDoseEntry("nuclear-medicine", "Myocardial perfusion")?.key
    ).toBe("nm-cardiac-perfusion");
    expect(resolveDoseEntry("nuclear-medicine", "Thyroid")?.key).toBe(
      "nm-thyroid"
    );
    // An unspecified nuclear study hits the modality-generic fallback.
    expect(resolveDoseEntry("nuclear-medicine", null)?.key).toBe("nm-generic");
    expect(resolveDoseEntry("fluoroscopy", "Coronary")?.key).toBe(
      "fluoro-coronary-angio"
    );
    expect(resolveDoseEntry("fluoroscopy", "Upper GI")?.key).toBe(
      "fluoro-upper-gi"
    );
    expect(resolveDoseEntry("fluoroscopy", null)?.key).toBe("fluoro-generic");
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

  it("PET / cardiac-SPECT / fluoro studies estimate NON-ZERO instead of 'none' (#1034)", () => {
    const pet = estimateStudyDose(
      study({ modality: "pet", body_region: "Whole body" })
    );
    expect(pet.source).toBe("estimate");
    expect(pet.msv).toBe(25);

    const spect = estimateStudyDose(
      study({
        modality: "nuclear-medicine",
        body_region: "Myocardial perfusion",
      })
    );
    expect(spect.source).toBe("estimate");
    expect(spect.msv).toBe(12);

    const fluoro = estimateStudyDose(study({ modality: "fluoroscopy" }));
    expect(fluoro.source).toBe("estimate");
    expect(fluoro.msv).toBe(10);
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

  it("a PET study contributes its ~25 mSv to the cumulative total (#1034)", () => {
    // The cardiac-patient case the issue pins: an annual stress SPECT + a PET
    // workup formerly contributed 0 while the total read as complete.
    const cum = cumulativeDose(
      [
        study({
          modality: "pet",
          body_region: "Whole body",
          study_date: "2025-03-01",
        }),
        study({
          modality: "nuclear-medicine",
          body_region: "Myocardial perfusion",
          study_date: "2025-06-01",
        }),
        // A genuinely unknown modality still refuses — the honest gap stays.
        study({ modality: "other", study_date: "2025-07-01" }),
      ],
      now
    );
    expect(cum.estimatedMsv).toBe(37); // 25 (PET) + 12 (cardiac SPECT)
    expect(cum.estimatedCount).toBe(2);
    expect(cum.studiesInWindow).toBe(3);
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
      expect(note).not.toContain("Informational, not medical advice.");
    }
  });

  it("carries pediatric framing for a child profile", () => {
    expect(doseFramingNote(true).toLowerCase()).toContain("children");
    expect(doseFramingNote(false).toLowerCase()).not.toContain("children");
  });
});

// ── #2970: the number can be decomposed ────────────────────────────────────────────
//
// The breakdown is generic over the study row so a caller keeps its own type. These
// fixtures carry an `id` the way the real ImagingStudy rows do, so the row identity a
// surface keys on is part of what's tested.
type IdStudy = DoseStudyInput & { id: number };

function idStudy(id: number, over: Partial<DoseStudyInput>): IdStudy {
  return { id, ...study(over) };
}

// The four real cases from the snapshot audit, in one record.
const AUDIT_STUDIES: IdStudy[] = [
  // Outside the 3-year lens, inside the record — the study the old headline dropped.
  // Listed FIRST on purpose: the rows are sorted by date, not by input order.
  idStudy(5, {
    modality: "x-ray",
    body_region: "Chest",
    study_date: "2021-04-02",
  }),
  // The same 2023-11-15 mammogram three times, as the overlapping portal exports left
  // it. Summed AS GIVEN — de-duplication belongs to the representative-id collapse
  // (#2919/#2952), and this module must not grow a second one.
  idStudy(11, {
    modality: "x-ray",
    body_region: "Breast",
    study_date: "2023-11-15",
  }),
  idStudy(17, {
    modality: "x-ray",
    body_region: "Breast",
    study_date: "2023-11-15",
  }),
  idStudy(23, {
    modality: "x-ray",
    body_region: "Breast",
    study_date: "2023-11-15",
  }),
  // Real imaging with no date: 0.1 mSv that was invisible in every figure.
  idStudy(3, { modality: "x-ray", body_region: "Chest", study_date: null }),
  // The refusal gate: never estimated, and until now never disclosed either.
  idStudy(7, { modality: "other", body_region: null, study_date: "2024-02-02" }),
  // Non-ionizing: a true 0, and the reason a "studies in window" count implied more
  // contributors than there were.
  idStudy(9, {
    modality: "ultrasound",
    body_region: "Abdomen",
    study_date: "2024-05-05",
  }),
];

function reasonFor(
  breakdown: ReturnType<typeof doseContributions<IdStudy>>,
  id: number
): DoseExclusionReason | undefined {
  return breakdown.exclusions.find((x) => x.study.id === id)?.reason;
}

describe("doseContributions — the studies behind the number (#2970)", () => {
  const now = "2026-08-15";

  it("names every contributing study, newest first, with its recorded-vs-estimate source", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    expect(b.contributions.map((c) => c.study.id)).toEqual([11, 17, 23, 5]);
    expect(b.contributions.map((c) => c.date)).toEqual([
      "2023-11-15",
      "2023-11-15",
      "2023-11-15",
      "2021-04-02",
    ]);
    for (const c of b.contributions) expect(c.dose.source).toBe("estimate");
    expect(b.contributions[0].dose.label).toBe("Mammography");
    expect(b.contributions[3].dose.label).toBe("Chest X-ray");
  });

  it("the all-records total equals the sum of the contributions it names", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    const summed = b.contributions.reduce((n, c) => n + c.dose.msv, 0);
    expect(combinedMsv(b.allRecords)).toBeCloseTo(summed, 6);
    // 0.4 × 3 mammograms + 0.1 chest X-ray.
    expect(combinedMsv(b.allRecords)).toBeCloseTo(1.3, 6);
    expect(b.allRecords.estimatedCount).toBe(b.contributions.length);
  });

  it("sums a repeated study AS GIVEN — no de-duplication in this module", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    const mammos = b.contributions.filter((c) => c.dose.label === "Mammography");
    expect(mammos).toHaveLength(3);
    expect(mammos.reduce((n, c) => n + c.dose.msv, 0)).toBeCloseTo(1.2, 6);
  });

  it("names the excluded studies with the reason each was left out", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    expect(reasonFor(b, 3)).toBe("no-date");
    expect(reasonFor(b, 7)).toBe("no-entry");
    expect(reasonFor(b, 9)).toBe("non-ionizing");
    // Every study in the record is accounted for exactly once — the whole point: a
    // study that reaches neither list is silence again.
    expect(b.contributions.length + b.exclusions.length).toBe(
      AUDIT_STUDIES.length
    );
    const named = [
      ...b.contributions.map((c) => c.study.id),
      ...b.exclusions.map((x) => x.study.id),
    ].sort((a, z) => a - z);
    expect(named).toEqual(AUDIT_STUDIES.map((s) => s.id).sort((a, z) => a - z));
  });

  it("sorts exclusions newest first and puts the undated ones last", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    expect(b.exclusions.map((x) => x.study.id)).toEqual([9, 7, 3]);
    expect(b.exclusions.at(-1)?.date).toBeNull();
  });

  it("flags which contributions also fall inside the 3-year lens", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    const byId = new Map(b.contributions.map((c) => [c.study.id, c.inWindow]));
    expect(byId.get(11)).toBe(true); // 2023-11-15, inside 2023-08-15…
    expect(byId.get(5)).toBe(false); // 2021-04-02, outside it
  });

  it("a windowYears of null means all records — nothing falls outside", () => {
    const b = doseContributions(AUDIT_STUDIES, now, null);
    expect(b.contributions.every((c) => c.inWindow)).toBe(true);
    expect(b.window.windowYears).toBeNull();
    expect(combinedMsv(b.window)).toBe(combinedMsv(b.allRecords));
  });

  it("labels the headline with the oldest CONTRIBUTING study's date", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    // Not 2024-05-05 (the ultrasound contributed nothing) and not the undated X-ray.
    expect(b.allRecords.earliest).toBe("2021-04-02");
    expect(b.window.earliest).toBe("2023-11-15");
  });

  it("has no earliest date when nothing contributed", () => {
    const b = doseContributions(
      [idStudy(1, { modality: "ultrasound", study_date: "2025-01-01" })],
      now
    );
    expect(b.allRecords.earliest).toBeNull();
    expect(b.allRecords.hasAnyDose).toBe(false);
  });
});

describe("the headline does not age downward (#2970)", () => {
  // The case the issue exists to remove: the 2023-11-15 mammograms turn three years old
  // and leave the trailing window. Under the OLD behaviour — a trailing window AS the
  // headline — the cumulative figure fell with no event and no explanation. A
  // cumulative-risk number must never go down, so the window became a secondary lens.
  //
  // The boundary is 2026-11-16, not the 2026-11-15 the issue names: windowStartDate is
  // INCLUSIVE, so a study dated exactly on the window start still counts that day.
  const before = "2026-08-15";
  const after = "2026-11-16";

  it("keeps the all-records total across the boundary while the 3-year lens drops", () => {
    const allBefore = cumulativeDose(AUDIT_STUDIES, before, null);
    const allAfter = cumulativeDose(AUDIT_STUDIES, after, null);
    expect(combinedMsv(allBefore)).toBeCloseTo(1.3, 6);
    expect(combinedMsv(allAfter)).toBeCloseTo(1.3, 6);

    // The same fixture through the trailing window — the arithmetic that used to BE
    // the headline — still drops, which is exactly why it is no longer the headline.
    const lensBefore = cumulativeDose(AUDIT_STUDIES, before);
    const lensAfter = cumulativeDose(AUDIT_STUDIES, after);
    expect(combinedMsv(lensBefore)).toBeCloseTo(1.2, 6);
    expect(combinedMsv(lensAfter)).toBe(0);
    expect(combinedMsv(lensAfter)).toBeLessThan(combinedMsv(lensBefore));
  });

  it("still names the aged-out studies in the breakdown after the boundary", () => {
    const b = doseContributions(AUDIT_STUDIES, after);
    expect(b.contributions.map((c) => c.study.id)).toContain(11);
    expect(b.contributions.every((c) => !c.inWindow)).toBe(true);
    expect(b.allRecords.hasAnyDose).toBe(true);
  });
});

describe("per-study labels the list and the breakdown share (#2970)", () => {
  it("marks an estimate as one at the figure, and leaves a recorded dose bare", () => {
    const recorded = estimateStudyDose(
      study({ modality: "ct", dose_msv: 12.5 })
    );
    expect(doseChipLabel(recorded)).toBe("12.5 mSv");
    expect(doseSourceNote(recorded)).toBe("Recorded in the report");

    const est = estimateStudyDose(
      study({ modality: "x-ray", body_region: "Breast" })
    );
    expect(doseChipLabel(est)).toBe("≈ 0.4 mSv est.");
    expect(doseSourceNote(est)).toBe("Typical for Mammography");
  });

  it("prints no chip where there is no honest figure (non-ionizing, unclassified)", () => {
    expect(doseChipLabel(estimateStudyDose(study({ modality: "mri" })))).toBeNull();
    expect(
      doseChipLabel(estimateStudyDose(study({ modality: "ultrasound" })))
    ).toBeNull();
    expect(
      doseChipLabel(estimateStudyDose(study({ modality: "other" })))
    ).toBeNull();
  });

  it("the chip on a study agrees with that study's breakdown row", () => {
    const b = doseContributions(AUDIT_STUDIES, "2026-08-15");
    for (const c of b.contributions) {
      expect(doseChipLabel(c.dose)).toBe(
        doseChipLabel(estimateStudyDose(c.study))
      );
    }
    // …and a study the breakdown excluded shows no chip either.
    for (const x of b.exclusions) {
      if (x.reason === "no-date") continue; // undated, but still a real 0.1 mSv X-ray
      expect(doseChipLabel(estimateStudyDose(x.study))).toBeNull();
    }
  });

  it("states each exclusion as a fact about the record, never a reproach", () => {
    const notes = (
      ["no-date", "no-entry", "non-ionizing"] as DoseExclusionReason[]
    ).map(doseExclusionNote);
    expect(notes[0]).toContain("No date recorded");
    expect(notes[1]).toContain("isn't estimated");
    expect(notes[2]).toBe("No ionizing radiation.");
    for (const n of notes) {
      expect(n.toLowerCase()).not.toContain("you should");
      expect(n.toLowerCase()).not.toContain("missing");
      expect(n.toLowerCase()).not.toContain("too much");
    }
  });
});

describe("backgroundEquivalentLabel — a comparison, not arithmetic", () => {
  const now = "2026-08-15";

  it("reads in months under two years", () => {
    const cum = cumulativeDose(
      [study({ modality: "ct", dose_msv: 3, study_date: "2025-01-01" })],
      now
    );
    expect(backgroundEquivalentMonths(cum)).toBe(12);
    expect(backgroundEquivalentLabel(cum)).toBe("12 months");
  });

  it("switches to years once months stop being readable", () => {
    // A lifetime total is exactly what the all-records headline makes possible, and
    // "148 months of natural background" is not a comparison anyone can picture.
    const cum = cumulativeDose(
      [study({ modality: "ct", dose_msv: 37, study_date: "2025-01-01" })],
      now
    );
    expect(backgroundEquivalentMonths(cum)).toBe(148);
    expect(backgroundEquivalentLabel(cum)).toBe("12.3 years");
  });

  it("is null when there is nothing to compare", () => {
    expect(backgroundEquivalentLabel(cumulativeDose([], now))).toBeNull();
  });
});
