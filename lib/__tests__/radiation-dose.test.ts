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
  formatScopeMsv,
  doseFramingNote,
  doseContributions,
  doseChipLabel,
  doseSourceNote,
  doseExclusionNote,
  describesAnyStudy,
  NON_IONIZING_MODALITIES,
  BACKGROUND_YEARS_CUTOVER_MONTHS,
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
    expect(cum.estimatedCount).toBe(1);
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
    expect(cum.estimatedCount).toBe(0);
    expect(cum.hasAnyDose).toBe(false);
  });

  it("excludes a study with no date (can't be placed in the window)", () => {
    const cum = cumulativeDose(
      [study({ modality: "ct", body_region: "Chest", study_date: null })],
      now
    );
    expect(cum.estimatedCount).toBe(0);
    expect(cum.hasAnyDose).toBe(false);
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

// The four real cases from the snapshot audit, in ONE COMPOSITE record. It is not any
// one profile's card: the mammograms and the undated X-ray are profile 2's, the 2021
// chest X-ray is profile 1's, and that X-ray's date does not appear in the issue at all
// (the snapshot is gone from the build host, so it could not be re-derived — see the
// premise-correction comment on #2970). Its 1.3 mSv headline is therefore a CONTRACT
// figure, not a number any card ever showed. What each row is faithful to is its CLASS:
// summed-as-given repeats, an undated study, a refusal, and a non-ionizing study.
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
  idStudy(7, {
    modality: "other",
    body_region: null,
    study_date: "2024-02-02",
  }),
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
    const mammos = b.contributions.filter(
      (c) => c.dose.label === "Mammography"
    );
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

  it("keeps the lens to the studies inside it while the headline names them all", () => {
    const b = doseContributions(AUDIT_STUDIES, now);
    // The 2021-04-02 chest X-ray is outside 2023-08-15…; the three mammograms are in.
    expect(combinedMsv(b.window)).toBeCloseTo(1.2, 6);
    expect(combinedMsv(b.allRecords)).toBeCloseTo(1.3, 6);
    expect(b.window.estimatedCount).toBe(3);
    expect(b.contributions).toHaveLength(4);
  });

  it("a windowYears of null means all records — the lens IS the headline", () => {
    const b = doseContributions(AUDIT_STUDIES, now, null);
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
    expect(combinedMsv(b.window)).toBe(0);
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
    expect(
      doseChipLabel(estimateStudyDose(study({ modality: "mri" })))
    ).toBeNull();
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

// ── #2970 review round: R1, R2, R5, R6, R7, R8 ─────────────────────────────────────

describe("describesAnyStudy — what the card renders on (#2970 R1)", () => {
  const now = "2026-08-15";

  it("is true for a record whose imaging is entirely un-attributable", () => {
    // Two undated chest X-rays, an unclassified study and an ultrasound: three named
    // exclusions and no total. Gating the card on the TOTAL deleted the only surface
    // that could explain them — while the list row still showed the undated X-ray's
    // "≈ 0.1 mSv est." chip. Silent on one surface, speaking on the other.
    const b = doseContributions(
      [
        idStudy(1, { modality: "x-ray", body_region: "Chest" }),
        idStudy(2, { modality: "x-ray", body_region: "Chest" }),
        idStudy(3, { modality: "other", study_date: "2025-01-01" }),
        idStudy(4, { modality: "ultrasound", study_date: "2025-02-01" }),
      ],
      now
    );
    expect(b.allRecords.hasAnyDose).toBe(false);
    expect(b.exclusions).toHaveLength(4);
    expect(describesAnyStudy(b)).toBe(true);
  });

  it("is false only when there is no imaging study at all", () => {
    expect(describesAnyStudy(doseContributions([], now))).toBe(false);
  });
});

describe("an undated study names the reason a date would actually fix (#2970 R2)", () => {
  const now = "2026-08-15";
  const four = (date: string | null): IdStudy[] => [
    idStudy(1, { modality: "x-ray", body_region: "Chest", study_date: date }),
    idStudy(2, {
      modality: "ultrasound",
      body_region: "Abdomen",
      study_date: date,
    }),
    idStudy(3, { modality: "other", study_date: date }),
    idStudy(4, { modality: "mri", body_region: "Knee", study_date: date }),
  ];

  it("files an undated study under no-date ONLY when a date would let it count", () => {
    const b = doseContributions(four(null), now);
    expect(reasonFor(b, 1)).toBe("no-date");
    expect(reasonFor(b, 2)).toBe("non-ionizing");
    expect(reasonFor(b, 3)).toBe("no-entry");
    expect(reasonFor(b, 4)).toBe("non-ionizing");
    // Only that one row asks for a date, because only that one row would change.
    const asksForADate = b.exclusions.filter((x) =>
      doseExclusionNote(x.reason).includes("Add a date")
    );
    expect(asksForADate.map((x) => x.study.id)).toEqual([1]);
  });

  it("adding the date changes the verdict for that study and for no other", () => {
    const undated = doseContributions(four(null), now);
    const dated = doseContributions(four("2025-03-04"), now);
    expect(dated.contributions.map((c) => c.study.id)).toEqual([1]);
    for (const id of [2, 3, 4]) {
      expect(reasonFor(dated, id)).toBe(reasonFor(undated, id));
    }
  });
});

// ── What a reader with a calculator does ───────────────────────────────────────────
//
// The figure PRINTED in a dose string, as text: "≈ 10.1 mSv est." → "10.1". Kept as a
// string on purpose — the point of these assertions is the characters on the card.
function printedFigure(formatted: string): string {
  const m = /(\d[\d.]*) mSv/.exec(formatted);
  expect(m, `unparseable dose figure: ${formatted}`).not.toBeNull();
  return m![1];
}

// Add printed figures the way a reader adds them: EXACT decimal arithmetic on the digits
// shown, with no rounding of any kind, returning the canonical decimal string.
//
// The previous assertion re-formatted the row sum — `formatMsv(rowSum) === formatMsv(total)`
// — and the final rounding erased the discrepancy the reader would see (#2970 R5): on an
// estimate-only record of ten 10 mSv CTs plus a 0.1 mSv chest X-ray, rows summing to 100.1
// under a headline of 100 mSv passed it. Nothing here may round.
function addPrinted(figures: string[]): string {
  const places = Math.max(
    0,
    ...figures.map((f) => (f.split(".")[1] ?? "").length)
  );
  let total = 0n;
  for (const f of figures) {
    const [whole, frac = ""] = f.split(".");
    total += BigInt(whole + frac.padEnd(places, "0"));
  }
  const neg = total < 0n;
  const digits = (neg ? -total : total).toString().padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const frac = places > 0 ? digits.slice(digits.length - places) : "";
  const trimmed = frac.replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

describe("addPrinted — the reader's arithmetic, which does not round", () => {
  it("adds the digits as shown", () => {
    expect(addPrinted(["10.1", "10.1"])).toBe("20.2");
    expect(addPrinted(["10", "10", "0.1"])).toBe("20.1");
    expect(addPrinted(["0.0005", "0.0005"])).toBe("0.001");
    expect(addPrinted(["0"])).toBe("0");
  });
});

describe("the headline equals the rows it names (#2970 R5)", () => {
  const now = "2026-08-15";

  // Putting the decomposition BESIDE the total is what makes a rounding disagreement
  // visible, so the card owes the reader an addition that works: the figures the rows
  // print must add up, digit for digit, to the figure the headline prints.
  //
  // The three cases at the top are the ones the second adversarial pass reproduced
  // against the shipped formatter — ordinary recorded CT doses (two decimals) and an
  // estimate-only record with no recorded dose at all.
  const cases: { label: string; doses: (number | null)[] }[] = [
    { label: "two recorded 10.05 mSv CTs", doses: [10.05, 10.05] },
    { label: "two recorded 10.03 mSv CTs", doses: [10.03, 10.03] },
    {
      label: "nineteen recorded 16.45 mSv CTs",
      doses: Array.from({ length: 19 }, () => 16.45),
    },
    { label: "three recorded 1.44 mSv studies", doses: [1.44, 1.44, 1.44] },
    {
      label: "five recorded 0.0005 mSv studies",
      doses: [0.0005, 0.0005, 0.0005, 0.0005, 0.0005],
    },
    {
      label: "three recorded 0.0004 mSv studies",
      doses: [0.0004, 0.0004, 0.0004],
    },
    { label: "three recorded 1e-7 mSv studies", doses: [1e-7, 1e-7, 1e-7] },
    { label: "three estimated mammograms", doses: [null, null, null] },
  ];

  for (const c of cases) {
    it(`adds up on the surface: ${c.label}`, () => {
      const b = doseContributions(
        c.doses.map((d, i) =>
          idStudy(i + 1, {
            modality: "x-ray",
            body_region: "Breast",
            dose_msv: d,
            study_date: "2025-01-01",
          })
        ),
        now
      );
      expect(b.contributions).toHaveLength(c.doses.length);
      const rows = b.contributions.map((x) =>
        printedFigure(doseChipLabel(x.dose)!)
      );
      const headline = printedFigure(
        formatScopeMsv(b.allRecords, combinedMsv(b.allRecords))
      );
      expect(addPrinted(rows)).toBe(headline);
    });
  }

  it("adds up on a record with no recorded dose at all", () => {
    // Ten CT abdomen/pelvis (10 mSv each) and one chest X-ray (0.1) — every figure an
    // estimate, which is what shipped records look like today. The rows print 100.1;
    // the headline printed 100.
    const studies = [
      ...Array.from({ length: 10 }, (_, i) =>
        idStudy(i + 1, {
          modality: "ct",
          body_region: "Abdomen and pelvis",
          study_date: "2025-01-01",
        })
      ),
      idStudy(11, {
        modality: "x-ray",
        body_region: "Chest",
        study_date: "2025-02-01",
      }),
    ];
    const b = doseContributions(studies, now);
    expect(b.contributions).toHaveLength(11);
    const rows = b.contributions.map((x) =>
      printedFigure(doseChipLabel(x.dose)!)
    );
    expect(addPrinted(rows)).toBe("100.1");
    expect(
      printedFigure(formatScopeMsv(b.allRecords, combinedMsv(b.allRecords)))
    ).toBe("100.1");
  });

  it("adds up across the card FACE: recorded + estimated is the headline", () => {
    // The same break one line down: `Recorded: 100 mSv` + `Estimated: 0.4 mSv` under a
    // headline of `≈ 100 mSv`. The split is printed at the same precision as the total.
    const b = doseContributions(
      [
        ...Array.from({ length: 10 }, (_, i) =>
          idStudy(i + 1, {
            modality: "ct",
            body_region: "Abdomen and pelvis",
            dose_msv: 10.05,
            study_date: "2025-01-01",
          })
        ),
        idStudy(11, {
          modality: "x-ray",
          body_region: "Breast",
          study_date: "2025-02-01",
        }),
      ],
      now
    );
    const { allRecords } = b;
    expect(allRecords.recordedCount).toBe(10);
    expect(allRecords.estimatedCount).toBe(1);
    const split = [
      printedFigure(formatScopeMsv(allRecords, allRecords.recordedMsv)),
      printedFigure(formatScopeMsv(allRecords, allRecords.estimatedMsv)),
    ];
    const headline = printedFigure(
      formatScopeMsv(allRecords, combinedMsv(allRecords))
    );
    expect(addPrinted(split)).toBe(headline);
    // …and the rows the reader can see add to the same figure.
    expect(
      addPrinted(
        b.contributions.map((x) => printedFigure(doseChipLabel(x.dose)!))
      )
    ).toBe(headline);
  });

  it("adds up for the 3-year lens over the rows inside it", () => {
    // The lens is a second total on the same card, over a subset of the same rows, so
    // it owes the reader the same addition.
    const b = doseContributions(
      [
        idStudy(1, {
          modality: "ct",
          body_region: "Chest",
          dose_msv: 10.05,
          study_date: "2025-01-01",
        }),
        idStudy(2, {
          modality: "ct",
          body_region: "Chest",
          dose_msv: 10.05,
          study_date: "2024-06-01",
        }),
        idStudy(3, {
          modality: "ct",
          body_region: "Chest",
          dose_msv: 10.05,
          study_date: "2019-01-01",
        }),
      ],
      now
    );
    const inLens = b.contributions.filter((c) => c.date >= b.window.since!);
    expect(inLens).toHaveLength(2);
    expect(
      addPrinted(inLens.map((x) => printedFigure(doseChipLabel(x.dose)!)))
    ).toBe(printedFigure(formatScopeMsv(b.window, combinedMsv(b.window))));
  });
});

describe("a future-dated study is not a date the record reaches back to (#2970)", () => {
  const now = "2026-08-15";

  it("says nothing about 'since' when the only contributing study is in the future", () => {
    // A CT typed as 2099-01-01 made the card say "From your records, since January 1,
    // 2099." The dose still counts — whether a future date should reach the fold at all
    // is the form's question, and the form now caps the field at today.
    const b = doseContributions(
      [
        idStudy(1, {
          modality: "ct",
          body_region: "Chest",
          study_date: "2099-01-01",
        }),
      ],
      now
    );
    expect(b.allRecords.hasAnyDose).toBe(true);
    expect(b.allRecords.earliest).toBeNull();
  });

  it("still names the oldest study that has actually happened", () => {
    const b = doseContributions(
      [
        idStudy(1, {
          modality: "ct",
          body_region: "Chest",
          study_date: "2099-01-01",
        }),
        idStudy(2, {
          modality: "x-ray",
          body_region: "Chest",
          study_date: "2021-04-02",
        }),
      ],
      now
    );
    expect(b.allRecords.earliest).toBe("2021-04-02");
  });
});

describe("the non-ionizing set is what carries the claim (#2970 R6)", () => {
  const now = "2026-08-15";

  it("names the two modalities that are non-ionizing by physics, and only those", () => {
    expect([...NON_IONIZING_MODALITIES].sort()).toEqual(["mri", "ultrasound"]);
  });

  it("reports MRI and ultrasound as carrying no ionizing radiation", () => {
    const b = doseContributions(
      [
        idStudy(1, { modality: "mri", study_date: "2025-01-01" }),
        idStudy(2, { modality: "ultrasound", study_date: "2025-02-01" }),
      ],
      now
    );
    expect(reasonFor(b, 1)).toBe("non-ionizing");
    expect(reasonFor(b, 2)).toBe("non-ionizing");
  });
});

describe("backgroundEquivalentLabel — the cutover and the years figure (#2970 R7)", () => {
  const now = "2026-08-15";
  const labelFor = (msv: number) =>
    backgroundEquivalentLabel(
      cumulativeDose(
        [study({ modality: "ct", dose_msv: msv, study_date: "2025-01-01" })],
        now
      )
    );

  it("reads months right up to the cutover and years from it on", () => {
    // ~3 mSv/yr background is 0.25 mSv per month, so the boundary is exact: 5.75 mSv
    // is 23 months and 6 mSv is 24. Both sides are asserted because a cutover pinned
    // only from far away (the old tests sat at 12 and 148 months) is pinned by nothing.
    expect(labelFor(5.75)).toBe("23 months");
    expect(labelFor(6)).toBe("2 years");
  });

  it("keeps the cutover a named constant rather than a literal in the branch", () => {
    expect(BACKGROUND_YEARS_CUTOVER_MONTHS).toBe(24);
  });

  it("derives the years figure from the dose, not from the rounded month count", () => {
    // 48.625 mSv is 16.208 years of background. Rounding to 195 months first and
    // dividing again reported 16.3 — a month and a bit of drift on a one-decimal figure.
    expect(labelFor(48.625)).toBe("16.2 years");
  });
});

describe("a recorded 0 and a NULL dose are different facts (#2970 R8)", () => {
  const now = "2026-08-15";
  const scan = (dose: number | null) =>
    doseContributions(
      [
        idStudy(1, {
          modality: "ultrasound",
          body_region: "Abdomen",
          dose_msv: dose,
          study_date: "2025-01-01",
        }),
      ],
      now
    );

  it("counts a recorded 0 — the report said 0, and that is a fact about the study", () => {
    const b = scan(0);
    expect(b.contributions).toHaveLength(1);
    expect(b.contributions[0].dose.source).toBe("recorded");
    expect(b.allRecords.hasAnyDose).toBe(true);
    expect(formatMsv(combinedMsv(b.allRecords))).toBe("0 mSv");
    expect(doseChipLabel(b.contributions[0].dose)).toBe("0 mSv");
  });

  it("names the same study as non-ionizing when no dose was recorded", () => {
    const b = scan(null);
    expect(b.contributions).toHaveLength(0);
    expect(reasonFor(b, 1)).toBe("non-ionizing");
    expect(b.allRecords.hasAnyDose).toBe(false);
  });

  it("speaks either way — the fork changes what the card says, not whether it speaks", () => {
    expect(describesAnyStudy(scan(0))).toBe(true);
    expect(describesAnyStudy(scan(null))).toBe(true);
  });
});
