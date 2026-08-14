import { describe, expect, it } from "vitest";
import type { ExtractedResult } from "../medical-extract";
import { uncuratedAnalytes } from "../canonical-name";
import {
  documentSource,
  bodyMetricsFromExtraction,
  bodyMetricsFromReadings,
  bodyMetricKind,
  hasBodyMetric,
  mergeBodyMetric,
  mergeBodyMetricPartialAware,
  roundBodyMetric,
  foldSampleIntoRow,
  documentRowAddsMetric,
  undeferredBodyMetrics,
} from "../body-metric-extract";

function result(partial: Partial<ExtractedResult>): ExtractedResult {
  return {
    category: "scan",
    panel: null,
    name: "",
    canonical_name: "",
    value: null,
    value_num: null,
    unit: null,
    reference_range: null,
    flag: null,
    collected_date: null,
    notes: null,
    ...partial,
  };
}

describe("bodyMetricsFromExtraction", () => {
  it("extracts weight, body fat, and resting HR grouped by date", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({
          name: "Total Mass",
          canonical_name: "Total Body Mass",
          value_num: 81.4,
          unit: "kg",
          collected_date: "2026-06-01",
        }),
        result({
          name: "Body Fat %",
          canonical_name: "Body Fat Percentage",
          value_num: 18.25,
          unit: "%",
          collected_date: "2026-06-01",
        }),
        result({
          name: "Resting Heart Rate",
          canonical_name: "Resting Heart Rate",
          value_num: 52.4,
          unit: "bpm",
          collected_date: "2026-06-01",
        }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-01",
        weight_kg: 81.4,
        body_fat_pct: 18.3,
        resting_hr: 52,
      },
    ]);
  });

  it("matches names regardless of word order and punctuation", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({ name: "Weight, Body", value_num: 80, unit: "kg" }),
        result({
          name: "Heart Rate, Resting",
          value_num: 55,
          unit: "bpm",
        }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      { date: "2026-06-15", weight_kg: 80, body_fat_pct: null, resting_hr: 55 },
    ]);
  });

  it("converts pounds and grams to kg", () => {
    const lb = bodyMetricsFromExtraction(
      [result({ name: "Weight", value_num: 180, unit: "lbs" })],
      "2026-06-15"
    );
    expect(lb[0].weight_kg).toBeCloseTo(81.65, 2);

    const grams = bodyMetricsFromExtraction(
      [result({ name: "Total Mass", value_num: 78500, unit: "g" })],
      "2026-06-15"
    );
    expect(grams[0].weight_kg).toBeCloseTo(78.5, 2);
  });

  it("skips weights with a missing or unrecognized unit (ambiguous, not assumed kg)", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({ name: "Weight", value_num: 180 }), // unit-less US report: pounds, not kg
        result({ name: "Weight", value_num: 12, unit: "st" }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([]);
  });

  it("skips body fat reported as a mass instead of a percentage", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({ name: "Weight", value_num: 80, unit: "kg" }),
        result({ name: "Total Body Fat", value_num: 25, unit: "kg" }), // fat mass
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-15",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
  });

  it("falls back to the document date when a result has no collected date", () => {
    const rows = bodyMetricsFromExtraction(
      [result({ name: "Body Weight", value_num: 75, unit: "kg" })],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-15",
        weight_kg: 75,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
  });

  it("skips results with no real date rather than inventing one", () => {
    const undated = bodyMetricsFromExtraction(
      [result({ name: "Weight", value_num: 80, unit: "kg" })],
      null
    );
    expect(undated).toEqual([]);

    const malformed = bodyMetricsFromExtraction(
      [
        result({
          name: "Weight",
          value_num: 80,
          unit: "kg",
          collected_date: "06/01/2026",
        }),
      ],
      "not-a-date"
    );
    expect(malformed).toEqual([]);
  });

  it("emits a weightless row for a date with only body fat / resting HR", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({ name: "Body Fat %", value_num: 22, unit: "%" }),
        result({ name: "Resting Heart Rate", value_num: 60 }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-15",
        weight_kg: null,
        body_fat_pct: 22,
        resting_hr: 60,
      },
    ]);
  });

  it("ignores regional masses, non-numeric values, and implausible readings", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({ name: "Arms Total Mass", value_num: 9.1, unit: "kg" }),
        result({ name: "Weight", value: ">80", value_num: null, unit: "kg" }),
        result({ name: "Weight", value_num: 1.2, unit: "kg" }), // below the 2 kg floor
        result({ name: "Body Fat %", value_num: 180, unit: "%" }), // implausible
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([]);
  });

  it("imports infant & toddler weights so pediatric growth charts get data", () => {
    // A 15 kg toddler and an 18 lb infant (~8.16 kg) are real body weights that
    // the old 20 kg floor silently dropped; both now project. A sub-2 kg value
    // stays rejected.
    const rows = bodyMetricsFromExtraction(
      [
        result({
          name: "Body Weight",
          value_num: 15.14,
          unit: "kg",
          collected_date: "2025-10-01",
        }),
        result({
          name: "Weight",
          value_num: 18,
          unit: "lb",
          collected_date: "2025-06-01",
        }),
        result({
          name: "Weight",
          value_num: 0.5,
          unit: "kg",
          collected_date: "2025-01-01",
        }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2025-06-01",
        weight_kg: 8.16,
        body_fat_pct: null,
        resting_hr: null,
      },
      {
        date: "2025-10-01",
        weight_kg: 15.14,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
  });

  it("keeps the first matching value per date and emits one row per date", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({
          name: "Weight",
          value_num: 80,
          unit: "kg",
          collected_date: "2026-06-02",
        }),
        result({
          name: "Total Mass",
          value_num: 79,
          unit: "kg",
          collected_date: "2026-06-02",
        }),
        result({
          name: "Weight",
          value_num: 81,
          unit: "kg",
          collected_date: "2026-06-01",
        }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-01",
        weight_kg: 81,
        body_fat_pct: null,
        resting_hr: null,
      },
      {
        date: "2026-06-02",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
  });
});

describe("bodyMetricKind classifier", () => {
  it("classifies weight / body fat / resting HR by name or canonical", () => {
    expect(bodyMetricKind("Body Weight", null)).toBe("weight");
    expect(bodyMetricKind("Weight, Body", null)).toBe("weight");
    expect(bodyMetricKind("Total Body Fat", null)).toBe("body_fat");
    // Deterministic HR: raw name "Heart rate", LOINC-canonicalized "Resting Heart Rate".
    expect(bodyMetricKind("Heart rate", "Resting Heart Rate")).toBe(
      "resting_hr"
    );
  });

  it("returns null for clinical vitals and labs (they stay in medical_records)", () => {
    expect(
      bodyMetricKind("Systolic blood pressure", "Blood Pressure Systolic")
    ).toBeNull();
    expect(bodyMetricKind("Body Temperature", "Body Temperature")).toBeNull();
    expect(bodyMetricKind("Oxygen Saturation", null)).toBeNull();
    expect(bodyMetricKind("Hepatitis B Surface Antibody", null)).toBeNull();
  });
});

describe("a unit printed inside the name (#2835)", () => {
  // A DEXA's total-mass row has two spellings in the wild, and both are declared
  // out-of-scope, so both get a declination. Only the bare one used to get the
  // thing the declination talks around: `normalizeCanonicalKey` keeps "(g)" as a
  // token, so "Total Mass (g)" matched nothing and yielded neither a weight row
  // nor a pointer to one — from a scan that had measured the person's weight.

  it("reads the gram-suffixed total mass as the same weight as the bare one", () => {
    expect(bodyMetricKind("Total Mass (g)", null)).toBe("weight");
    expect(bodyMetricKind("Total Mass", null)).toBe("weight");
  });

  it("absorbs a printed unit for every body metric, not just that one name", () => {
    // The class, not the symptom. A single added string would have fixed the row
    // the audit happened to find and left its siblings.
    expect(bodyMetricKind("Weight (kg)", null)).toBe("weight");
    expect(bodyMetricKind("Body Weight (lb)", null)).toBe("weight");
    expect(bodyMetricKind("Total Body Mass (kg)", null)).toBe("weight");
    expect(bodyMetricKind("Total Body Fat (percent)", null)).toBe("body_fat");
    expect(bodyMetricKind("Resting Heart Rate (bpm)", null)).toBe("resting_hr");
    // Via the canonical column too, not only the verbatim name.
    expect(bodyMetricKind("Gewicht", "Body Weight (kg)")).toBe("weight");
  });

  it("keeps a regional mass regional — the suffix is all that comes off", () => {
    // "Arms Total Mass" is a limb, not a body weight, and de-suffixing must not
    // widen what matches.
    expect(bodyMetricKind("Arms Total Mass (g)", null)).toBeNull();
    expect(bodyMetricKind("Trunk Lean Mass (g)", null)).toBeNull();
  });

  it("leaves a parenthetical that is not a unit alone", () => {
    // A bracket can qualify the MEASUREMENT rather than state its unit, and those
    // are different readings. Filing an ideal or a target as the weight itself
    // would put a number nobody stepped on a scale for onto the weight chart.
    expect(bodyMetricKind("Weight (Ideal)", null)).toBeNull();
    expect(bodyMetricKind("Weight (Target)", null)).toBeNull();
    // BMI is not a weight either, however mass-shaped its unit looks.
    expect(bodyMetricKind("Body Mass (kg/m2)", null)).toBeNull();
  });

  it("projects the gram-suffixed row all the way to a weight in kg", () => {
    const rows = bodyMetricsFromExtraction(
      [
        result({
          name: "Total Mass (g)",
          value_num: 78500,
          unit: "g",
          collected_date: "2026-06-01",
        }),
      ],
      "2026-06-15"
    );
    expect(rows).toEqual([
      {
        date: "2026-06-01",
        weight_kg: 78.5,
        body_fat_pct: null,
        resting_hr: null,
      },
    ]);
  });

  it("closes the gap for every declared name, not only the one that was found", () => {
    // THE CLASS GUARD. Walks the whole uncurated-analyte registry: no declared
    // spelling may extract nothing while its bare form extracts something. That
    // asymmetry is the defect — a reader gets a declination for a measurement the
    // app would otherwise have plotted, and no weight either — and it can arrive
    // again from the registry side, since the "(g)" twins are minted by a cross
    // product rather than hand-listed.
    const asymmetric: string[] = [];
    for (const [name] of uncuratedAnalytes()) {
      const bare = name.replace(/\s*\([^()]*\)\s*$/, "");
      if (bare === name) continue;
      if (bodyMetricKind(bare, null) && !bodyMetricKind(name, null)) {
        asymmetric.push(
          `${name} (bare form extracts as ${bodyMetricKind(bare, null)})`
        );
      }
    }
    expect(
      asymmetric,
      "a declined name whose bare spelling IS extracted must be extracted too — " +
        "otherwise one spelling of one measurement yields a weight and the other " +
        "yields nothing at all"
    ).toEqual([]);
  });
});

describe("bodyMetricsFromReadings (generic projection)", () => {
  it("projects deterministic-shaped readings; clinical vitals are ignored", () => {
    const rows = bodyMetricsFromReadings(
      [
        {
          name: "Body Weight",
          canonical: "Body Weight",
          value_num: 82,
          unit: "kg",
          date: "2024-01-10",
        },
        {
          name: "Heart rate",
          canonical: "Resting Heart Rate",
          value_num: 61,
          unit: "/min",
          date: "2024-01-10",
        },
        {
          name: "Systolic blood pressure",
          canonical: "Blood Pressure Systolic",
          value_num: 118,
          unit: "mm[Hg]",
          date: "2024-01-10",
        },
      ],
      null
    );
    expect(rows).toEqual([
      { date: "2024-01-10", weight_kg: 82, body_fat_pct: null, resting_hr: 61 },
    ]);
  });

  it("accepts UCUM avoirdupois pounds ([lb_av])", () => {
    const rows = bodyMetricsFromReadings(
      [
        {
          name: "Body Weight",
          canonical: "Body Weight",
          value_num: 180,
          unit: "[lb_av]",
          date: "2024-01-10",
        },
      ],
      null
    );
    expect(rows[0].weight_kg).toBeCloseTo(81.65, 2);
  });
});

describe("documentSource", () => {
  it("encodes a document id into the body_metrics source string", () => {
    expect(documentSource(12)).toBe("document:12");
  });
});

describe("hasBodyMetric", () => {
  it("is false only when all three measures are null", () => {
    expect(
      hasBodyMetric({ weight_kg: null, body_fat_pct: null, resting_hr: null })
    ).toBe(false);
    expect(
      hasBodyMetric({ weight_kg: 80, body_fat_pct: null, resting_hr: null })
    ).toBe(true);
    expect(
      hasBodyMetric({ weight_kg: null, body_fat_pct: null, resting_hr: 60 })
    ).toBe(true);
  });
});

describe("mergeBodyMetric (integration upsert merge)", () => {
  it("a non-null incoming value overwrites; a null one keeps the existing", () => {
    // A later sync window with only a corrected weight must not blank the body
    // fat / resting HR an earlier window already stored.
    const existing = { weight_kg: 80, body_fat_pct: 18, resting_hr: 55 };
    const incoming = { weight_kg: 79.5, body_fat_pct: null, resting_hr: null };
    expect(mergeBodyMetric(existing, incoming)).toEqual({
      weight_kg: 79.5, // corrected weight wins
      body_fat_pct: 18, // kept — incoming had none
      resting_hr: 55, // kept
    });
  });

  it("fills gaps on an existing row that was missing a measure", () => {
    expect(
      mergeBodyMetric(
        { weight_kg: 80, body_fat_pct: null, resting_hr: null },
        { weight_kg: null, body_fat_pct: 20, resting_hr: 60 }
      )
    ).toEqual({ weight_kg: 80, body_fat_pct: 20, resting_hr: 60 });
  });

  it("all-null incoming leaves the existing row untouched", () => {
    const existing = { weight_kg: 80, body_fat_pct: 18, resting_hr: 55 };
    expect(
      mergeBodyMetric(existing, {
        weight_kg: null,
        body_fat_pct: null,
        resting_hr: null,
      })
    ).toEqual(existing);
  });
});

describe("mergeBodyMetricPartialAware (#606 partial-window guard)", () => {
  const stored = { weight_kg: 76, body_fat_pct: 20, resting_hr: 58 };

  it("on a fully-covered day, behaves exactly like mergeBodyMetric (incoming wins)", () => {
    const incoming = { weight_kg: 75.5, body_fat_pct: 19, resting_hr: 60 };
    expect(mergeBodyMetricPartialAware(stored, incoming, false)).toEqual(
      mergeBodyMetric(stored, incoming)
    );
    expect(mergeBodyMetricPartialAware(stored, incoming, false)).toEqual(
      incoming
    );
  });

  it("on a partial day, a partial-tail body-fat/RHR average never overwrites the stored value", () => {
    // The batch's partial-tail "day average" (60 bpm from one late sample) must not
    // clobber the fuller stored 58 computed when the day was wholly in the window.
    const incoming = { weight_kg: null, body_fat_pct: 21, resting_hr: 60 };
    expect(mergeBodyMetricPartialAware(stored, incoming, true)).toEqual({
      weight_kg: 76, // kept (incoming had none)
      body_fat_pct: 20, // stored wins on a partial day
      resting_hr: 58, // stored wins on a partial day
    });
  });

  it("on a partial day, weight (last-of-day, not an average) still overwrites", () => {
    const incoming = { weight_kg: 74.8, body_fat_pct: null, resting_hr: null };
    expect(mergeBodyMetricPartialAware(stored, incoming, true)).toEqual({
      weight_kg: 74.8,
      body_fat_pct: 20,
      resting_hr: 58,
    });
  });

  it("on a partial day, a gap the stored row lacks is still filled", () => {
    const existing = { weight_kg: 76, body_fat_pct: null, resting_hr: null };
    const incoming = { weight_kg: null, body_fat_pct: 22, resting_hr: 61 };
    expect(mergeBodyMetricPartialAware(existing, incoming, true)).toEqual({
      weight_kg: 76,
      body_fat_pct: 22, // filled (existing was null)
      resting_hr: 61, // filled (existing was null)
    });
  });
});

describe("roundBodyMetric", () => {
  it("rounds each column to its stored precision", () => {
    expect(roundBodyMetric("resting_hr", 58.6)).toBe(59); // whole bpm
    expect(roundBodyMetric("body_fat_pct", 18.25)).toBe(18.3); // 0.1%
    expect(roundBodyMetric("weight_kg", 80.1249)).toBe(80.12); // 0.01 kg
  });
});

describe("foldSampleIntoRow (metric_samples → body_metrics precedence)", () => {
  it("an existing manual/document value wins; a gap takes the sample", () => {
    expect(foldSampleIntoRow(17, 18.5)).toBe(17); // existing wins
    expect(foldSampleIntoRow(null, 18.5)).toBe(18.5); // gap filled
    expect(foldSampleIntoRow(0, 18.5)).toBe(0); // 0 is a real value, not a gap
  });
});

const NONE = { weight_kg: false, body_fat_pct: false, resting_hr: false };

describe("documentRowAddsMetric (per-measure defer)", () => {
  const row = { weight_kg: 80, body_fat_pct: null, resting_hr: null };
  it("keeps a weight the date doesn't already cover", () => {
    // The date only has an integration resting-HR row → the document's weight is new.
    expect(documentRowAddsMetric(row, { ...NONE, resting_hr: true })).toBe(
      true
    );
  });
  it("defers when the only measure is already covered", () => {
    expect(documentRowAddsMetric(row, { ...NONE, weight_kg: true })).toBe(
      false
    );
  });
  it("keeps a multi-measure row when any measure is new", () => {
    expect(
      documentRowAddsMetric(
        { weight_kg: 80, body_fat_pct: 18, resting_hr: null },
        { ...NONE, weight_kg: true } // weight covered, body fat is new
      )
    ).toBe(true);
  });
});

describe("undeferredBodyMetrics (document defer rule)", () => {
  it("drops a row only when the date already covers every measure it carries", () => {
    const rows = [
      {
        date: "2024-01-01",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
      {
        date: "2024-01-02",
        weight_kg: 81,
        body_fat_pct: null,
        resting_hr: null,
      },
      {
        date: "2024-01-03",
        weight_kg: 82,
        body_fat_pct: null,
        resting_hr: null,
      },
    ];
    // 01 has only a resting-HR row (weight is new → keep); 02 already has a weight
    // (redundant → drop); 03 has nothing (keep).
    const coverage: Record<string, typeof NONE> = {
      "2024-01-01": { ...NONE, resting_hr: true },
      "2024-01-02": { ...NONE, weight_kg: true },
      "2024-01-03": NONE,
    };
    expect(
      undeferredBodyMetrics(rows, (d) => coverage[d] ?? NONE).map((r) => r.date)
    ).toEqual(["2024-01-01", "2024-01-03"]);
  });

  it("keeps all rows when the dates cover nothing", () => {
    const rows = [
      {
        date: "2024-01-01",
        weight_kg: 80,
        body_fat_pct: null,
        resting_hr: null,
      },
      {
        date: "2024-01-02",
        weight_kg: null,
        body_fat_pct: null,
        resting_hr: 60,
      },
    ];
    expect(undeferredBodyMetrics(rows, () => NONE)).toHaveLength(2);
  });
});
