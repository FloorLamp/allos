import { describe, expect, it } from "vitest";
import {
  ageBandLabel,
  daysBetween,
  DEFAULT_RETEST_DAYS,
  humanizeAge,
  isBiomarkerStale,
  optimalBand,
  optimalStatus,
  parseLooseValue,
  parseReferenceRange,
  rangeBadge,
  reconciledFlag,
  referenceRange,
  referenceStatus,
  retestIntervalDays,
  selectAgeBand,
  selectStatusRange,
} from "@/lib/reference-range";

describe("parseReferenceRange", () => {
  it("parses one-sided upper bounds", () => {
    expect(parseReferenceRange("<200")).toEqual({ high: 200 });
    expect(parseReferenceRange("≤200")).toEqual({ high: 200 });
    expect(parseReferenceRange("< 200")).toEqual({ high: 200 });
  });

  it("parses one-sided lower bounds", () => {
    expect(parseReferenceRange(">40")).toEqual({ low: 40 });
    expect(parseReferenceRange("≥40")).toEqual({ low: 40 });
  });

  it("parses two-sided ranges with hyphen, dashes, and 'to'", () => {
    expect(parseReferenceRange("50-180")).toEqual({ low: 50, high: 180 });
    expect(parseReferenceRange("50 – 180")).toEqual({ low: 50, high: 180 });
    expect(parseReferenceRange("50 to 180")).toEqual({ low: 50, high: 180 });
  });

  it("orders reversed bounds low→high", () => {
    expect(parseReferenceRange("180-50")).toEqual({ low: 50, high: 180 });
  });

  it("returns null for empty or non-numeric input", () => {
    expect(parseReferenceRange("")).toBeNull();
    expect(parseReferenceRange(null)).toBeNull();
    expect(parseReferenceRange("NEGATIVE")).toBeNull();
  });
});

describe("parseLooseValue", () => {
  it("parses bounded (censored) values", () => {
    expect(parseLooseValue("<0.10")).toEqual({ value: 0.1, bound: "<" });
    expect(parseLooseValue("≥40")).toEqual({ value: 40, bound: ">" });
  });

  it("parses plain numbers", () => {
    expect(parseLooseValue("4.2")).toEqual({ value: 4.2 });
  });

  it("returns null for qualitative / embedded strings", () => {
    expect(parseLooseValue("1:160")).toBeNull();
    expect(parseLooseValue("Pattern A")).toBeNull();
    expect(parseLooseValue("12 mg/dL")).toBeNull();
    expect(parseLooseValue(null)).toBeNull();
  });
});

describe("referenceStatus", () => {
  it("judges a value against a [low, high] range", () => {
    expect(referenceStatus(5, 10, 20)).toBe("below");
    expect(referenceStatus(25, 10, 20)).toBe("above");
    expect(referenceStatus(15, 10, 20)).toBe("in");
  });

  it("returns unknown when there are no bounds", () => {
    expect(referenceStatus(15, null, null)).toBe("unknown");
  });

  it("honors open-ended bounds", () => {
    expect(referenceStatus(100, null, 50)).toBe("above");
    expect(referenceStatus(100, 50, null)).toBe("in");
  });
});

describe("optimalBand", () => {
  const cb = {
    optimal_low: 1,
    optimal_high: 9,
    optimal_low_male: 2,
    optimal_high_male: 8,
    optimal_low_female: 3,
    optimal_high_female: 7,
  };

  it("prefers a sex-specific override when present", () => {
    expect(optimalBand(cb, "male")).toEqual({
      low: 2,
      high: 8,
      bySex: true,
      band: null,
    });
    expect(optimalBand(cb, "female")).toEqual({
      low: 3,
      high: 7,
      bySex: true,
      band: null,
    });
  });

  it("falls back to the generic band when sex is unknown", () => {
    expect(optimalBand(cb, null)).toEqual({
      low: 1,
      high: 9,
      bySex: false,
      band: null,
    });
  });

  it("returns nulls for a missing biomarker", () => {
    expect(optimalBand(null)).toEqual({
      low: null,
      high: null,
      bySex: false,
      band: null,
    });
  });
});

describe("optimalStatus", () => {
  // Build the full optimal-band shape (sex overrides default to null) so the
  // generic band is what gets exercised.
  const band = (
    low: number | null,
    high: number | null,
    direction: "higher_better" | "lower_better" | "in_range"
  ) => ({
    optimal_low: low,
    optimal_high: high,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
    direction,
  });

  it("higher_better: only a lower bound matters", () => {
    const cb = band(50, null, "higher_better");
    expect(optimalStatus(60, cb)).toBe("optimal");
    expect(optimalStatus(40, cb)).toBe("below");
  });

  it("lower_better: only an upper bound matters", () => {
    const cb = band(null, 100, "lower_better");
    expect(optimalStatus(80, cb)).toBe("optimal");
    expect(optimalStatus(120, cb)).toBe("above");
  });

  it("in_range: outside [low, high] is below/above", () => {
    const cb = band(10, 20, "in_range");
    expect(optimalStatus(15, cb)).toBe("optimal");
    expect(optimalStatus(5, cb)).toBe("below");
    expect(optimalStatus(25, cb)).toBe("above");
  });

  it("is unknown without a value or band", () => {
    const cb = band(10, 20, "in_range");
    expect(optimalStatus(null, cb)).toBe("unknown");
    expect(optimalStatus(15, null)).toBe("unknown");
  });
});

describe("rangeBadge", () => {
  // Reference range 4–6, optimal band 5–5.5.
  const cb = {
    name: "X",
    unit: "u",
    ref_low: 4,
    ref_high: 6,
    direction: "in_range" as const,
    optimal_low: 5,
    optimal_high: 5.5,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
  };

  it("flags out-of-range before optimal (precedence)", () => {
    expect(rangeBadge(7, cb)).toBe("high");
    expect(rangeBadge(3, cb)).toBe("low");
  });

  it("flags non-optimal inside the reference range", () => {
    expect(rangeBadge(5.8, cb)).toBe("above-optimal");
    expect(rangeBadge(4.5, cb)).toBe("below-optimal");
  });

  it("reports optimal inside the optimal band", () => {
    expect(rangeBadge(5.2, cb)).toBe("optimal");
  });

  it("is unknown without a value or biomarker", () => {
    expect(rangeBadge(null, cb)).toBe("unknown");
    expect(rangeBadge(5, null)).toBe("unknown");
  });
});

describe("reconciledFlag", () => {
  const noOptimal = {
    name: "X",
    unit: "u",
    ref_low: 4,
    ref_high: 6,
    direction: "in_range" as const,
    optimal_low: null,
    optimal_high: null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
  };

  it("never touches a qualitative 'abnormal' flag", () => {
    expect(reconciledFlag("abnormal", 5, "u", noOptimal)).toBeUndefined();
  });

  it("makes no judgment without a value or biomarker", () => {
    expect(reconciledFlag("low", null, "u", noOptimal)).toBeUndefined();
    expect(reconciledFlag("low", 5, "u", null)).toBeUndefined();
  });

  it("catches an out-of-range value the lab did not flag", () => {
    // Value below our reference range, currently unflagged → set "low".
    expect(reconciledFlag(null, 2, "u", noOptimal)).toBe("low");
  });

  it("relaxes a stale clinical flag when the value is inside our range", () => {
    // Value in [4,6] but flagged "low" → clear it (null).
    expect(reconciledFlag("low", 5, "u", noOptimal)).toBeNull();
  });

  it("leaves an already-correct out-of-range flag unchanged", () => {
    expect(reconciledFlag("low", 2, "u", noOptimal)).toBeUndefined();
  });

  const withOptimal = {
    ...noOptimal,
    optimal_low: 4.5,
    optimal_high: 5.5,
  };

  it("derives directional non-optimal inside the reference range", () => {
    // In [4,6] but outside the optimal [4.5,5.5] → directional non-optimal.
    expect(reconciledFlag(null, 5.8, "u", withOptimal)).toBe(
      "non-optimal-high"
    );
    expect(reconciledFlag(null, 4.2, "u", withOptimal)).toBe("non-optimal-low");
  });

  it("leaves an already-correct directional non-optimal flag unchanged", () => {
    expect(
      reconciledFlag("non-optimal-high", 5.8, "u", withOptimal)
    ).toBeUndefined();
  });

  it("clears a non-optimal flag (any variant) once the value is optimal", () => {
    expect(reconciledFlag("non-optimal-high", 5, "u", withOptimal)).toBeNull();
    expect(reconciledFlag("non-optimal", 5, "u", withOptimal)).toBeNull();
  });

  // A sex-divergent analyte: generic reference is a permissive union, with tight
  // sex-specific overrides (mirrors testosterone's shape in the dataset).
  const sexRef = {
    ...noOptimal,
    ref_low: 8,
    ref_high: 916,
    ref_low_male: 264,
    ref_high_male: 916,
    ref_low_female: 8,
    ref_high_female: 60,
  };

  it("judges against the sex-specific reference range when sex is known", () => {
    // 40 is normal for a female but 'low' for a male.
    expect(reconciledFlag(null, 40, "u", sexRef, "female")).toBeUndefined();
    expect(reconciledFlag(null, 40, "u", sexRef, "male")).toBe("low");
  });

  it("falls back to the generic union range when sex is unknown", () => {
    // In [8,916] → not flagged, so a female value never reads 'low' by default.
    expect(reconciledFlag(null, 40, "u", sexRef)).toBeUndefined();
  });
});

describe("referenceRange", () => {
  const cb = {
    ref_low: 8,
    ref_high: 916,
    ref_low_male: 264,
    ref_high_male: 916,
    ref_low_female: 8,
    ref_high_female: 60,
  };

  it("returns the sex-specific range for a known sex", () => {
    expect(referenceRange(cb, "male")).toEqual({
      low: 264,
      high: 916,
      bySex: true,
      band: null,
    });
    expect(referenceRange(cb, "female")).toEqual({
      low: 8,
      high: 60,
      bySex: true,
      band: null,
    });
  });

  it("falls back to the generic range when sex is unknown", () => {
    expect(referenceRange(cb, null)).toEqual({
      low: 8,
      high: 916,
      bySex: false,
      band: null,
    });
  });

  it("falls back to generic when no sex-specific bound exists", () => {
    expect(referenceRange({ ref_low: 4, ref_high: 6 }, "male")).toEqual({
      low: 4,
      high: 6,
      bySex: false,
      band: null,
    });
  });
});

describe("selectStatusRange (reproductive status)", () => {
  const ranges = {
    premenopausal: { ref_low: 1, ref_high: 21 },
    // Open low bound, mirroring the committed postmenopausal FSH: an
    // HRT-suppressed value must not be false-flagged 'low'.
    postmenopausal: { ref_low: null, ref_high: 134.8 },
  };

  it("resolves the status range for a female with a set status", () => {
    expect(selectStatusRange(ranges, "female", "postmenopausal")).toEqual({
      ref_low: null,
      ref_high: 134.8,
    });
    expect(selectStatusRange(ranges, "female", "premenopausal")).toEqual({
      ref_low: 1,
      ref_high: 21,
    });
  });

  it("returns null for male sex (female physiology only)", () => {
    expect(selectStatusRange(ranges, "male", "postmenopausal")).toBeNull();
    expect(selectStatusRange(ranges, "male", "premenopausal")).toBeNull();
  });

  it("returns null when sex or status is unset, or no range exists", () => {
    expect(selectStatusRange(ranges, null, "postmenopausal")).toBeNull();
    expect(selectStatusRange(ranges, "female", null)).toBeNull();
    expect(selectStatusRange(null, "female", "postmenopausal")).toBeNull();
    expect(
      selectStatusRange(
        { premenopausal: { ref_low: 1, ref_high: 21 } },
        "female",
        "postmenopausal"
      )
    ).toBeNull();
  });

  it("parses a JSON-string ranges_by_status (raw SQLite SELECT shape)", () => {
    expect(
      selectStatusRange(JSON.stringify(ranges), "female", "postmenopausal")
    ).toEqual({ ref_low: null, ref_high: 134.8 });
    expect(selectStatusRange("not json", "female", "premenopausal")).toBeNull();
  });
});

describe("referenceRange — reproductive status precedence", () => {
  // A female hormone entry: sex-adult female envelope, a 51+ age band, and
  // reproductive-status overrides. Mirrors the committed FSH shape.
  const fsh = {
    ref_low: null,
    ref_high: 21,
    ref_low_male: 1,
    ref_high_male: 12.5,
    ref_low_female: 1,
    ref_high_female: 21,
    ranges_by_age: [
      {
        min_age: 51,
        max_age: null,
        ref_low: 1,
        ref_high: 135,
        ref_low_male: 1,
        ref_high_male: 20,
        ref_low_female: 1,
        ref_high_female: 135,
      },
    ],
    ranges_by_status: {
      premenopausal: { ref_low: 1, ref_high: 21 },
      postmenopausal: { ref_low: null, ref_high: 134.8 },
    },
  };

  it("status range beats the age band (status > age band)", () => {
    // A 60-yr-old female: without status the 51+ age band (1–135) applies; with
    // premenopausal status the reproductive 1–21 wins — proving status precedence.
    expect(referenceRange(fsh, "female", 60)).toEqual({
      low: 1,
      high: 135,
      bySex: true,
      band: { min_age: 51, max_age: null },
    });
    expect(referenceRange(fsh, "female", 60, "premenopausal")).toEqual({
      low: 1,
      high: 21,
      bySex: true,
      band: null,
    });
    expect(referenceRange(fsh, "female", 60, "postmenopausal")).toEqual({
      low: null,
      high: 134.8,
      bySex: true,
      band: null,
    });
  });

  it("status applies even with no age band in play (age < 51)", () => {
    expect(referenceRange(fsh, "female", 40, "postmenopausal")).toEqual({
      low: null,
      high: 134.8,
      bySex: true,
      band: null,
    });
  });

  it("male profiles are unaffected by a reproductive status", () => {
    // Status is ignored for males — the male adult range (age <51) is unchanged.
    expect(referenceRange(fsh, "male", 40, "postmenopausal")).toEqual(
      referenceRange(fsh, "male", 40)
    );
    expect(referenceRange(fsh, "male", 40, "postmenopausal")).toEqual({
      low: 1,
      high: 12.5,
      bySex: true,
      band: null,
    });
  });

  it("unset status is unchanged (today's age-proxy behavior)", () => {
    expect(referenceRange(fsh, "female", 60, null)).toEqual(
      referenceRange(fsh, "female", 60)
    );
    expect(referenceRange(fsh, "female", 30, null)).toEqual(
      referenceRange(fsh, "female", 30)
    );
  });
});

describe("selectAgeBand", () => {
  const bands = [
    { min_age: 0, max_age: 1, ref_low: 80, ref_high: 450 },
    { min_age: 1, max_age: 10, ref_low: 140, ref_high: 420 },
    { min_age: 10, max_age: null, ref_low: 40, ref_high: 129 },
  ];

  it("picks the band whose half-open [min, max) contains the age", () => {
    expect(selectAgeBand(bands, 0)?.ref_high).toBe(450);
    expect(selectAgeBand(bands, 5)?.ref_high).toBe(420);
    expect(selectAgeBand(bands, 40)?.ref_high).toBe(129);
  });

  it("treats max_age as exclusive (boundary falls into the next band)", () => {
    expect(selectAgeBand(bands, 1)?.ref_low).toBe(140); // not the 0–1 band
    expect(selectAgeBand(bands, 10)?.ref_low).toBe(40); // open-ended top band
  });

  it("returns null with no age, no bands, or no match", () => {
    expect(selectAgeBand(bands, null)).toBeNull();
    expect(selectAgeBand(bands, undefined)).toBeNull();
    expect(selectAgeBand(null, 5)).toBeNull();
    expect(selectAgeBand([{ min_age: 5, max_age: 10 }], 2)).toBeNull();
  });

  it("parses a JSON-string ranges_by_age (raw SQLite SELECT shape)", () => {
    expect(selectAgeBand(JSON.stringify(bands), 5)?.ref_high).toBe(420);
    expect(selectAgeBand("not json", 5)).toBeNull();
  });
});

describe("ageBandLabel", () => {
  it("labels bounded, infant, and open-ended bands", () => {
    expect(ageBandLabel({ min_age: 6, max_age: 12 })).toBe("age 6–12");
    expect(ageBandLabel({ min_age: 0, max_age: 2 })).toBe("age <2");
    expect(ageBandLabel({ min_age: 65, max_age: null })).toBe("age 65+");
    expect(ageBandLabel(null)).toBeNull();
  });
});

describe("age-banded reference ranges", () => {
  // ALP-shaped: adult 40–129, with a childhood band and a puberty band that also
  // splits by sex — exercises the age→sex resolution order.
  const alp = {
    name: "Alkaline Phosphatase",
    unit: "U/L",
    ref_low: 40,
    ref_high: 129,
    direction: "in_range" as const,
    optimal_low: null,
    optimal_high: null,
    optimal_low_male: null,
    optimal_high_male: null,
    optimal_low_female: null,
    optimal_high_female: null,
    ranges_by_age: [
      { min_age: 1, max_age: 10, ref_low: 140, ref_high: 420 },
      {
        min_age: 13,
        max_age: 15,
        ref_low: 57,
        ref_high: 468,
        ref_low_male: 116,
        ref_high_male: 468,
        ref_low_female: 57,
        ref_high_female: 254,
      },
    ],
  };

  it("uses the age band's range when an age matches", () => {
    expect(referenceRange(alp, null, 5)).toEqual({
      low: 140,
      high: 420,
      bySex: false,
      band: { min_age: 1, max_age: 10 },
    });
  });

  it("falls back to the adult range when no age or no band matches", () => {
    expect(referenceRange(alp, null)).toEqual({
      low: 40,
      high: 129,
      bySex: false,
      band: null,
    });
    // Age 30 is past every band → adult fields.
    expect(referenceRange(alp, "male", 30)).toEqual({
      low: 40,
      high: 129,
      bySex: false,
      band: null,
    });
  });

  it("resolves the sex override WITHIN the matched age band", () => {
    expect(referenceRange(alp, "female", 14)).toEqual({
      low: 57,
      high: 254,
      bySex: true,
      band: { min_age: 13, max_age: 15 },
    });
    expect(referenceRange(alp, "male", 14)).toEqual({
      low: 116,
      high: 468,
      bySex: true,
      band: { min_age: 13, max_age: 15 },
    });
  });

  it("flags against the age band, not the adult range", () => {
    // 300 U/L is normal for a 5-year-old (band 140–420) but 'high' for an adult.
    expect(reconciledFlag(null, 300, "U/L", alp, null, 5)).toBeUndefined();
    expect(reconciledFlag(null, 300, "U/L", alp, null, 40)).toBe("high");
    // A child value below the pediatric floor is still caught.
    expect(reconciledFlag(null, 100, "U/L", alp, null, 5)).toBe("low");
  });
});

describe("daysBetween / staleness / humanizeAge", () => {
  it("counts whole days between two ISO dates", () => {
    expect(daysBetween("2024-01-01", "2024-01-08")).toBe(7);
    expect(daysBetween("2024-01-08", "2024-01-01")).toBe(-7);
  });

  it("returns 0 for unparseable dates", () => {
    expect(daysBetween("not-a-date", "2024-01-01")).toBe(0);
  });

  it("marks old readings stale but never genomics", () => {
    expect(isBiomarkerStale("2022-01-01", "labs", "2024-01-01")).toBe(true);
    expect(isBiomarkerStale("2022-01-01", "genomics", "2024-01-01")).toBe(
      false
    );
    expect(isBiomarkerStale("2023-12-01", "labs", "2024-01-01")).toBe(false);
    expect(isBiomarkerStale(null, "labs", "2024-01-01")).toBe(false);
  });
});

describe("retestIntervalDays (per-biomarker cadence)", () => {
  it("returns the curated interval when present and positive", () => {
    expect(retestIntervalDays(90)).toBe(90);
    expect(retestIntervalDays(180)).toBe(180);
    expect(retestIntervalDays(1825)).toBe(1825);
  });

  it("falls back to the 365-day default for null/undefined/non-positive", () => {
    expect(retestIntervalDays(null)).toBe(DEFAULT_RETEST_DAYS);
    expect(retestIntervalDays(undefined)).toBe(365);
    expect(retestIntervalDays(0)).toBe(365);
    expect(retestIntervalDays(-30)).toBe(365);
  });
});

describe("isBiomarkerStale with a per-biomarker interval", () => {
  it("uses a short cadence so a 100-day-old quarterly marker is stale", () => {
    // 100 days > 90-day HbA1c cadence → stale, though it's well under a year and
    // would NOT be stale under the flat 365-day rule.
    expect(isBiomarkerStale("2024-01-01", "lab", "2024-04-10", 90)).toBe(true);
    expect(isBiomarkerStale("2024-01-01", "lab", "2024-04-10")).toBe(false);
  });

  it("does not surface a 100-day-old annual marker (365 cadence)", () => {
    expect(isBiomarkerStale("2024-01-01", "lab", "2024-04-10", 365)).toBe(
      false
    );
  });

  it("is stale strictly AFTER the window, not on the boundary day", () => {
    // Exactly 90 days later is NOT yet stale (age > interval); 91 days is.
    expect(isBiomarkerStale("2024-01-01", "lab", "2024-03-31", 90)).toBe(false);
    expect(isBiomarkerStale("2024-01-01", "lab", "2024-04-01", 90)).toBe(true);
  });

  it("keeps genomics exempt regardless of the interval", () => {
    expect(isBiomarkerStale("2020-01-01", "genomics", "2024-01-01", 90)).toBe(
      false
    );
  });

  it("a null interval reproduces the flat 365-day behavior", () => {
    expect(isBiomarkerStale("2022-01-01", "lab", "2024-01-01", null)).toBe(
      true
    );
    expect(isBiomarkerStale("2023-12-01", "lab", "2024-01-01", null)).toBe(
      false
    );
  });

  it("humanizes spans of days", () => {
    expect(humanizeAge(1)).toBe("1 day");
    expect(humanizeAge(10)).toBe("10 days");
    expect(humanizeAge(90)).toBe("3 months");
    expect(humanizeAge(365)).toBe("12 months");
    expect(humanizeAge(600)).toContain("year");
  });
});
