import { describe, expect, it } from "vitest";
import {
  normalizeVaccineName,
  expandToComponents,
  slugifyVaccine,
  vaccineDisplayName,
} from "@/lib/immunization-catalog";
import {
  assessSchedule,
  applyOverride,
  filterCategoryFor,
  titerImmuneStatus,
  immuneThresholdFor,
  creditedDoseCount,
  datesByCodeFromRecords,
  seriesLengthForCode,
  doseNumberLabel,
  resolveDoseLabels,
  resolveDoseLabelsByVaccine,
  immunizationHasDuplicateVaccineDate,
  type ImmunizationRecordLite,
  type VaccineOverride,
} from "@/lib/immunization-status";

function statusFor(code: string, s: ReturnType<typeof assessSchedule>) {
  return s.assessments.find((a) => a.code === code)!;
}

describe("normalizeVaccineName", () => {
  it("maps brand names and abbreviations onto catalog codes", () => {
    expect(normalizeVaccineName("Boostrix")).toBe("tdap");
    expect(normalizeVaccineName("Adacel")).toBe("tdap");
    expect(normalizeVaccineName("Shingrix")).toBe("zoster");
    expect(normalizeVaccineName("MMR")).toBe("mmr");
    expect(normalizeVaccineName("Hepatitis B")).toBe("hepb");
    expect(normalizeVaccineName("YF-VAX")).toBe("yellow_fever");
  });

  it("maps combination shots to the combo code", () => {
    expect(normalizeVaccineName("Vaxelis")).toBe("vaxelis");
    expect(normalizeVaccineName("ProQuad")).toBe("proquad");
  });

  it("returns null for an unrecognized name (caller slugs it)", () => {
    expect(normalizeVaccineName("Some Novel Jab")).toBeNull();
    expect(slugifyVaccine("Some Novel Jab")).toBe("some_novel_jab");
    expect(vaccineDisplayName("some_novel_jab")).toBe("Some Novel Jab");
  });
});

describe("combination expansion", () => {
  it("expands a combo to its component vaccine codes", () => {
    expect(expandToComponents("vaxelis").sort()).toEqual(
      ["dtap", "hepb", "hib", "ipv"].sort()
    );
    expect(expandToComponents("dtap")).toEqual(["dtap"]);
    expect(expandToComponents("unknown_slug")).toEqual([]);
  });

  it("credits every component series from a single combo dose", () => {
    const recs: ImmunizationRecordLite[] = [
      { vaccine: "vaxelis", date: "2025-01-01" },
    ];
    const map = datesByCodeFromRecords(recs);
    for (const c of ["dtap", "ipv", "hib", "hepb"])
      expect(map.get(c)).toEqual(["2025-01-01"]);
  });
});

describe("titerImmuneStatus", () => {
  it("reads qualitative strings (negatives before positives)", () => {
    expect(titerImmuneStatus("Immune")).toBe("immune");
    expect(titerImmuneStatus("Reactive")).toBe("immune");
    expect(titerImmuneStatus("Non-reactive")).toBe("non_immune");
    expect(titerImmuneStatus("Not Detected")).toBe("non_immune");
    expect(titerImmuneStatus("Negative")).toBe("non_immune");
    expect(titerImmuneStatus("1:160")).toBe("indeterminate");
    expect(titerImmuneStatus(null)).toBe("indeterminate");
  });

  it("does not invert a negated positive term to immune", () => {
    // Regression: "Not Reactive"/"Not Protective"/"Non-immune" must be non_immune,
    // not caught by the positive matcher for reactive/protective/immune.
    expect(titerImmuneStatus("Not Reactive")).toBe("non_immune");
    expect(titerImmuneStatus("Not Protective")).toBe("non_immune");
    expect(titerImmuneStatus("Not Present")).toBe("non_immune");
    expect(titerImmuneStatus("Non-immune")).toBe("non_immune");
  });

  it("treats a leading 'no'/'none' as non-immune (absence phrasing)", () => {
    // Regression: "No antibody detected" must not fall through to the positive
    // matcher (which would catch "detected") and read as immune.
    expect(titerImmuneStatus("No antibody detected")).toBe("non_immune");
    expect(titerImmuneStatus("None detected")).toBe("non_immune");
    expect(titerImmuneStatus("No immunity")).toBe("non_immune");
    // A positive value that merely contains the word "no" mid-string stays immune.
    expect(titerImmuneStatus("Immune, no further testing needed")).toBe(
      "immune"
    );
  });

  it("applies a numeric threshold when one is known", () => {
    expect(titerImmuneStatus("12", { immuneAtLeast: 10 })).toBe("immune");
    expect(titerImmuneStatus("<10", { immuneAtLeast: 10 })).toBe("non_immune");
    expect(titerImmuneStatus("4", { immuneAtLeast: 10 })).toBe("non_immune");
  });
});

describe("immuneThresholdFor", () => {
  it("recognizes anti-HBs spellings by token (not a fixed list)", () => {
    for (const m of [
      "Hepatitis B Surface Antibody",
      "Anti-HBs",
      "HBsAb",
      "Hepatitis B Surface Ab, Quantitative",
      "Surface Antibody, Hepatitis B",
    ])
      expect(immuneThresholdFor(m)).toBe(10);
  });

  it("returns undefined for markers with no numeric threshold", () => {
    expect(immuneThresholdFor("Measles IgG")).toBeUndefined();
    expect(immuneThresholdFor("Varicella IgG")).toBeUndefined();
  });
});

describe("assessSchedule", () => {
  const on = "2026-07-01";

  it("marks a childhood series overdue when a dose is missing at age", () => {
    // A 2-year-old (24 months) with no MMR record: dose 1 (12mo) is overdue.
    const s = assessSchedule([], 24, null, on);
    expect(statusFor("mmr", s).status).toBe("overdue");
  });

  it("marks a series complete once all doses are recorded", () => {
    const recs: ImmunizationRecordLite[] = [
      { vaccine: "mmr", date: "2021-01-01" },
      { vaccine: "mmr", date: "2025-01-01" },
    ];
    expect(statusFor("mmr", assessSchedule(recs, 24, null, on)).status).toBe(
      "complete"
    );
  });

  it("treats an immune titer as completing the series", () => {
    const s = assessSchedule([], 24, null, on, [
      { marker: "Measles IgG", status: "immune" },
    ]);
    expect(statusFor("mmr", s).status).toBe("complete");
    expect(statusFor("mmr", s).hasImmuneTiter).toBe(true);
  });

  it("returns 'unknown' for an adult with no childhood records", () => {
    // 40-year-old, no records: childhood series long past → can't tell.
    const s = assessSchedule([], 40 * 12, null, on);
    expect(statusFor("mmr", s).status).toBe("unknown");
  });

  it("flags a Tdap booster overdue past the 10-year interval", () => {
    const recs: ImmunizationRecordLite[] = [
      { vaccine: "tdap", date: "2010-01-01" },
    ];
    expect(
      statusFor("tdap", assessSchedule(recs, 40 * 12, null, on)).status
    ).toBe("overdue");
    const recent: ImmunizationRecordLite[] = [
      { vaccine: "tdap", date: "2024-01-01" },
    ];
    expect(
      statusFor("tdap", assessSchedule(recent, 40 * 12, null, on)).status
    ).toBe("up_to_date");
  });

  it("gates one-time vaccines by age (Zoster ≥50)", () => {
    expect(
      statusFor("zoster", assessSchedule([], 40 * 12, null, on)).status
    ).toBe("not_recommended");
    expect(
      statusFor("zoster", assessSchedule([], 60 * 12, null, on)).status
    ).toBe("due");
  });

  it("never flags travel/record-only vaccines as due or overdue", () => {
    const s = assessSchedule([], 60 * 12, null, on);
    const yf = statusFor("yellow_fever", s);
    expect(["not_recommended", "up_to_date"]).toContain(yf.status);
    // A recorded travel dose reads as up_to_date, never overdue.
    const s2 = assessSchedule(
      [{ vaccine: "yellow_fever", date: "2024-05-01" }],
      60 * 12,
      null,
      on
    );
    expect(statusFor("yellow_fever", s2).status).toBe("up_to_date");
  });

  it("summarizes next-recommended and counts", () => {
    const s = assessSchedule([], 24, null, on);
    expect(s.nextRecommended).not.toBeNull();
    expect(s.overdueCount + s.dueCount).toBeGreaterThan(0);
  });

  it("marks a school-age child (not adult) overdue for a missing childhood series", () => {
    // 6-year-old (72 months), no MMR on file → a real gap, must be overdue.
    expect(statusFor("mmr", assessSchedule([], 72, null, on)).status).toBe(
      "overdue"
    );
    // 25-year-old, no record → genuinely unknown (records likely lost).
    expect(statusFor("mmr", assessSchedule([], 25 * 12, null, on)).status).toBe(
      "unknown"
    );
  });

  it("does not flag seasonal vaccines for an infant under 6 months", () => {
    const s = assessSchedule([], 2, null, on); // 2-month-old
    expect(statusFor("influenza", s).status).toBe("not_recommended");
    expect(statusFor("covid", s).status).toBe("not_recommended");
    // At 8 months they become due.
    expect(statusFor("influenza", assessSchedule([], 8, null, on)).status).toBe(
      "due"
    );
  });

  it("honors an immune titer for a time-based booster (tetanus)", () => {
    const s = assessSchedule([], 40 * 12, null, on, [
      { marker: "Tetanus IgG", status: "immune" },
    ]);
    expect(statusFor("tdap", s).status).toBe("up_to_date");
  });

  it("resolves a component-list combo name to the combo (credits all series)", () => {
    expect(normalizeVaccineName("DTaP-IPV-Hib-HepB")).toBe("vaxelis");
    expect(normalizeVaccineName("HepA-HepB")).toBe("twinrix");
    const s = assessSchedule(
      [{ vaccine: "vaxelis", date: "2024-01-01" }],
      6,
      null,
      on
    );
    // One combo dose credits each component series' first dose.
    for (const c of ["dtap", "ipv", "hib", "hepb"])
      expect(statusFor(c, s).dosesReceived).toBeGreaterThanOrEqual(1);
  });

  it("stops recommending HPV past its routine catch-up window", () => {
    // Within window (age 20): due; past window (age 40): no longer routine.
    expect(statusFor("hpv", assessSchedule([], 20 * 12, null, on)).status).toBe(
      "due"
    );
    expect(statusFor("hpv", assessSchedule([], 40 * 12, null, on)).status).toBe(
      "not_recommended"
    );
  });

  it("stops recommending HPV past the window even with a partial series", () => {
    // Regression: a 40-year-old with one recorded HPV dose is no longer
    // routinely recommended to finish — must not read "due" forever.
    const oneDose: ImmunizationRecordLite[] = [
      { vaccine: "hpv", date: "2015-06-01" },
    ];
    expect(
      statusFor("hpv", assessSchedule(oneDose, 40 * 12, null, on)).status
    ).toBe("not_recommended");
    // Still due mid-window (age 20) with a partial series.
    expect(
      statusFor("hpv", assessSchedule(oneDose, 20 * 12, null, on)).status
    ).toBe("due");
  });

  it("credits two same-week HPV doses as ONE, so the series isn't 'complete'", () => {
    // The exact bug: two doses logged days apart shouldn't finish a 2-dose series.
    const close: ImmunizationRecordLite[] = [
      { vaccine: "hpv", date: "2025-06-01" },
      { vaccine: "hpv", date: "2025-06-05" },
    ];
    const a = statusFor("hpv", assessSchedule(close, 20 * 12, null, on));
    expect(a.status).toBe("due");
    expect(a.dosesReceived).toBe(1); // second dose collapsed
    expect(a.detail).toContain("counted once");
  });

  it("credits properly-spaced HPV doses (>=5 months) as a complete series", () => {
    const spaced: ImmunizationRecordLite[] = [
      { vaccine: "hpv", date: "2025-01-01" },
      { vaccine: "hpv", date: "2025-07-01" }, // ~6 months later
    ];
    const a = statusFor("hpv", assessSchedule(spaced, 20 * 12, null, on));
    expect(a.status).toBe("complete");
    expect(a.dosesReceived).toBe(2);
    expect(a.detail).not.toContain("counted once");
  });

  it("flags an adolescent overdue for a missing Tdap booster, adult unknown", () => {
    // Regression: a 12-year-old (tracked since birth) missing the adolescent
    // Tdap is a real gap → overdue, not "no record".
    expect(
      statusFor("tdap", assessSchedule([], 12 * 12, null, on)).status
    ).toBe("overdue");
    // An adult with no booster on record is genuinely unknown (dose likely just
    // never entered), not overdue.
    expect(
      statusFor("tdap", assessSchedule([], 40 * 12, null, on)).status
    ).toBe("unknown");
  });

  it("degrades to record-only assessment when age is unknown", () => {
    const s = assessSchedule(
      [{ vaccine: "mmr", date: "2000-01-01" }],
      null,
      null,
      on
    );
    // With a dose on file but no age, a partial series reads up_to_date, not overdue.
    expect(statusFor("mmr", s).status).toBe("up_to_date");
  });
});

describe("manual overrides (immune / declined)", () => {
  const on = "2026-07-01";

  it("immune override completes an incomplete series (self-reported)", () => {
    // 1 of 2 varicella doses would be up_to_date/due; the immune override counts
    // it complete, flagged as override-driven so the UI can label it.
    const recs: ImmunizationRecordLite[] = [
      { vaccine: "varicella", date: "2020-01-01" },
    ];
    const overrides: VaccineOverride[] = [
      { vaccine: "varicella", kind: "immune", reason: "Prior infection" },
    ];
    const s = assessSchedule(recs, 8 * 12, null, on, [], overrides);
    const a = statusFor("varicella", s);
    expect(a.status).toBe("complete");
    expect(a.override).toBe("immune");
    expect(a.detail).toBe("Immune (self-reported)");
    // Immune reads as the "immune" filter bucket, not plain "complete".
    expect(filterCategoryFor(a)).toBe("immune");
  });

  it("declined override is terminal and leaves needs-attention", () => {
    // An overdue-by-schedule vaccine, declined, must not count as due/overdue.
    const overrides: VaccineOverride[] = [
      { vaccine: "covid", kind: "declined" },
    ];
    const s = assessSchedule([], 40 * 12, null, on, [], overrides);
    const a = statusFor("covid", s);
    expect(a.status).toBe("declined");
    expect(a.override).toBe("declined");
    expect(filterCategoryFor(a)).toBe("declined");
    // Not surfaced anywhere in the needs-attention counts.
    expect(s.assessments.filter((x) => x.status === "declined")).toContain(a);
    const attention = s.assessments.filter(
      (x) => x.status === "due" || x.status === "overdue"
    );
    expect(attention).not.toContain(a);
  });

  it("declined wins even over a genuinely complete series", () => {
    const recs: ImmunizationRecordLite[] = [
      { vaccine: "mmr", date: "2021-01-01" },
      { vaccine: "mmr", date: "2025-01-01" },
    ];
    const overrides: VaccineOverride[] = [{ vaccine: "mmr", kind: "declined" }];
    const s = assessSchedule(recs, 24, null, on, [], overrides);
    expect(statusFor("mmr", s).status).toBe("declined");
  });

  it("immune override keeps 'titer confirmed' wording when a titer backs it", () => {
    // A real immune titer already completes MMR; layering an immune override on
    // top keeps the titer-confirmed detail rather than the self-reported one.
    const s = assessSchedule([], 24, null, on, [
      { marker: "Measles IgG", status: "immune" },
    ]);
    const a = applyOverride(statusFor("mmr", s), {
      vaccine: "mmr",
      kind: "immune",
    });
    expect(a.status).toBe("complete");
    expect(a.detail).toBe("Immune (titer confirmed)");
  });

  it("applyOverride returns the assessment unchanged with no override", () => {
    const s = assessSchedule([], 24, null, on);
    const a = statusFor("mmr", s);
    expect(applyOverride(a, undefined)).toBe(a);
  });

  it("filterCategoryFor distinguishes complete from immune and needs-attention", () => {
    const s = assessSchedule(
      [
        { vaccine: "mmr", date: "2021-01-01" },
        { vaccine: "mmr", date: "2025-01-01" },
      ],
      24,
      null,
      on
    );
    // A fully-dosed series with no titer/override is plain "complete".
    expect(filterCategoryFor(statusFor("mmr", s))).toBe("complete");
    // A due childhood series with no record collapses into needs-attention.
    const due = assessSchedule([], 24, null, on);
    expect(filterCategoryFor(statusFor("mmr", due))).toBe("needs-attention");
  });
});

describe("seriesLengthForCode", () => {
  it("returns the dose count for a fixed primary series", () => {
    expect(seriesLengthForCode("dtap")).toBe(5); // 5-dose series
    expect(seriesLengthForCode("mmr")).toBe(2);
    expect(seriesLengthForCode("hepb")).toBe(3);
  });

  it("returns the dose count for a fixed multi-dose one_time schedule", () => {
    expect(seriesLengthForCode("hpv")).toBe(2);
    expect(seriesLengthForCode("zoster")).toBe(2);
  });

  it("returns null for open-ended / single / combo / unknown codes", () => {
    expect(seriesLengthForCode("tdap")).toBeNull(); // booster
    expect(seriesLengthForCode("influenza")).toBeNull(); // annual
    expect(seriesLengthForCode("pneumo_adult")).toBeNull(); // one_time, doses=1
    expect(seriesLengthForCode("bcg")).toBeNull(); // record_only
    expect(seriesLengthForCode("vaxelis")).toBeNull(); // combo, no own schedule
    expect(seriesLengthForCode("some_novel_jab")).toBeNull(); // unknown slug
  });
});

describe("doseNumberLabel", () => {
  it("appends of-M only when a total is known", () => {
    expect(doseNumberLabel(1, 3)).toBe("Dose 1 of 3");
    expect(doseNumberLabel(2, null)).toBe("Dose 2");
  });
});

describe("resolveDoseLabels", () => {
  it("numbers doses by date ascending, with of-M when total known", () => {
    const labels = resolveDoseLabels(
      [
        { id: 10, date: "2022-06-01" },
        { id: 11, date: "2020-01-01" },
        { id: 12, date: "2021-03-01" },
      ],
      3
    );
    expect(labels.get(11)).toBe("Dose 1 of 3");
    expect(labels.get(12)).toBe("Dose 2 of 3");
    expect(labels.get(10)).toBe("Dose 3 of 3");
  });

  it("omits of-M when the series length is unknown (null)", () => {
    const labels = resolveDoseLabels(
      [
        { id: 1, date: "2020-01-01" },
        { id: 2, date: "2021-01-01" },
      ],
      null
    );
    expect(labels.get(1)).toBe("Dose 1");
    expect(labels.get(2)).toBe("Dose 2");
  });

  it("keeps a user's explicit dose_label over the auto number", () => {
    const labels = resolveDoseLabels(
      [
        { id: 1, date: "2020-01-01", dose_label: null },
        { id: 2, date: "2021-01-01", dose_label: "Booster" },
      ],
      3
    );
    expect(labels.get(1)).toBe("Dose 1 of 3");
    expect(labels.get(2)).toBe("Booster");
  });

  it("breaks same-date ties by id for a stable order", () => {
    const labels = resolveDoseLabels(
      [
        { id: 5, date: "2020-01-01" },
        { id: 2, date: "2020-01-01" },
      ],
      null
    );
    expect(labels.get(2)).toBe("Dose 1");
    expect(labels.get(5)).toBe("Dose 2");
  });
});

describe("resolveDoseLabelsByVaccine", () => {
  it("numbers each stored dose within its own vaccine's sequence", () => {
    const labels = resolveDoseLabelsByVaccine([
      { id: 1, date: "2020-01-01", vaccine: "mmr" },
      { id: 2, date: "2024-01-01", vaccine: "mmr" },
      { id: 3, date: "2019-01-01", vaccine: "hepb" },
      { id: 4, date: "2019-06-01", vaccine: "vaxelis" }, // combo → no of-M
    ]);
    expect(labels.get(1)).toBe("Dose 1 of 2"); // mmr, earlier
    expect(labels.get(2)).toBe("Dose 2 of 2"); // mmr, later
    expect(labels.get(3)).toBe("Dose 1 of 3"); // hepb
    expect(labels.get(4)).toBe("Dose 1"); // combo, unknown length
  });
});

describe("creditedDoseCount", () => {
  it("always credits the first dose", () => {
    expect(creditedDoseCount(["2025-01-01"], 28)).toBe(1);
    expect(creditedDoseCount([], 28)).toBe(0);
  });

  it("collapses doses spaced closer than the minimum into one", () => {
    // Three doses within a week, min 28 days → one credited dose.
    expect(
      creditedDoseCount(["2025-01-01", "2025-01-03", "2025-01-06"], 28)
    ).toBe(1);
  });

  it("credits doses at or beyond the minimum interval", () => {
    // Exactly 28 days apart counts (>=), and a third far out counts too.
    expect(
      creditedDoseCount(["2025-01-01", "2025-01-29", "2025-06-01"], 28)
    ).toBe(3);
  });

  it("measures spacing from the last CREDITED dose, not the raw previous one", () => {
    // 2nd dose collapses into the 1st; the 3rd is measured from the 1st (28d),
    // so it still counts — the collapsed dose doesn't reset the clock.
    expect(
      creditedDoseCount(["2025-01-01", "2025-01-10", "2025-01-29"], 28)
    ).toBe(2);
  });
});

describe("immunizationHasDuplicateVaccineDate (issue #534)", () => {
  const items = [
    { id: 1, vaccine: "influenza", date: "2025-10-01" },
    { id: 2, vaccine: "influenza", date: "2025-10-01" }, // dup of #1
    { id: 3, vaccine: "influenza", date: "2024-10-01" }, // same vaccine, other date
    { id: 4, vaccine: "tdap", date: "2025-10-01" }, // same date, other vaccine
  ];

  it("flags a same-vaccine same-date twin", () => {
    expect(immunizationHasDuplicateVaccineDate(items, items[0])).toBe(true);
    expect(immunizationHasDuplicateVaccineDate(items, items[1])).toBe(true);
  });

  it("does not flag a row unique on vaccine+date", () => {
    expect(immunizationHasDuplicateVaccineDate(items, items[2])).toBe(false);
    expect(immunizationHasDuplicateVaccineDate(items, items[3])).toBe(false);
  });
});
