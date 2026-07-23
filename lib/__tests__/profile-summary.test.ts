import { describe, expect, it } from "vitest";
import {
  normalizeAbo,
  normalizeRh,
  resolveBloodType,
  bloodTypeFromReadings,
  computeBmi,
  mergeVitals,
  medicationStartDate,
  buildProfileSummary,
  buildPassportImmunizations,
  type SummaryVital,
  type ProfileSummaryInput,
  type PassportImmunizationRecord,
} from "../profile-summary";
import {
  assessSchedule,
  type TiterStatus,
  type VaccineOverride,
} from "../immunization-status";

describe("medicationStartDate", () => {
  it("uses the open course's started_on", () => {
    expect(
      medicationStartDate(
        [
          { started_on: "2026-01-01", stopped_on: "2026-02-01" },
          { started_on: "2026-06-01", stopped_on: null },
        ],
        "2025-01-01 12:00:00"
      )
    ).toBe("2026-06-01");
  });

  it("takes the most recent start when several courses are open", () => {
    expect(
      medicationStartDate(
        [
          { started_on: "2026-03-01", stopped_on: null },
          { started_on: "2026-05-01", stopped_on: null },
        ],
        null
      )
    ).toBe("2026-05-01");
  });

  it("falls back to the created date (date portion) when no course is open", () => {
    expect(
      medicationStartDate(
        [{ started_on: "2026-01-01", stopped_on: "2026-02-01" }],
        "2025-07-08 09:30:00"
      )
    ).toBe("2025-07-08");
    expect(medicationStartDate([], "2025-07-08 09:30:00")).toBe("2025-07-08");
  });

  it("is null when there is no open course and no created date", () => {
    expect(medicationStartDate([], null)).toBeNull();
    expect(
      medicationStartDate([{ started_on: null, stopped_on: null }], null)
    ).toBeNull();
  });
});

describe("normalizeAbo", () => {
  it("reads A/B/AB/O from clean and noisy values", () => {
    expect(normalizeAbo("O")).toBe("O");
    expect(normalizeAbo("A")).toBe("A");
    expect(normalizeAbo("AB")).toBe("AB");
    expect(normalizeAbo("Blood Group O")).toBe("O");
    expect(normalizeAbo("Type AB")).toBe("AB");
  });

  it("returns null for empty or unrecognizable values", () => {
    expect(normalizeAbo(null)).toBeNull();
    expect(normalizeAbo("")).toBeNull();
    expect(normalizeAbo("unknown")).toBeNull();
  });

  // A lone digit ZERO means group O: it's the standard European notation ("0 Rh
  // positiv") and the obvious AI/OCR misread of an O. There is no ABO group named
  // zero, so in a value already identified as a blood group it can't mean anything
  // else.
  it("reads a standalone zero as the letter O", () => {
    expect(normalizeAbo("0")).toBe("O");
    expect(normalizeAbo("0 POSITIVE")).toBe("O");
    expect(normalizeAbo("0 Rh positiv")).toBe("O"); // German report notation
    expect(normalizeAbo("Group 0")).toBe("O");
    expect(normalizeAbo("0+")).toBe("O");
  });

  // The coercion must never mangle a number: a zero touching a digit or a decimal
  // separator is part of a value, not a blood group.
  it("does not read a zero inside a number as a group", () => {
    for (const v of ["10", "100", "40", "1:160", "0.5", "0,5"])
      expect(normalizeAbo(v), v).toBeNull();
  });
});

describe("normalizeRh", () => {
  it("reads sign from +/- and words", () => {
    expect(normalizeRh("Positive")).toBe("+");
    expect(normalizeRh("negative")).toBe("-");
    expect(normalizeRh("+")).toBe("+");
    expect(normalizeRh("-")).toBe("-");
    expect(normalizeRh(null)).toBeNull();
  });
});

describe("resolveBloodType", () => {
  it("combines ABO group with Rh sign", () => {
    expect(resolveBloodType("O", "Positive")).toBe("O+");
    expect(resolveBloodType("AB", "negative")).toBe("AB-");
  });

  it("shows the group alone when Rh is unknown", () => {
    expect(resolveBloodType("A", null)).toBe("A");
  });

  it("is null when the ABO group is missing (Rh alone is meaningless)", () => {
    expect(resolveBloodType(null, "Positive")).toBeNull();
    expect(resolveBloodType("", "")).toBeNull();
  });
});

describe("bloodTypeFromReadings", () => {
  const reading = (name: string, value: string | null, canonical?: string) => ({
    name,
    canonical: canonical ?? name,
    value,
  });

  it("reads the two-row form (separate ABO + Rh records)", () => {
    expect(
      bloodTypeFromReadings([
        reading("ABO Blood Group", "A"),
        reading("Rh Type", "POSITIVE"),
      ])
    ).toBe("A+");
  });

  // Epic's real shape: ONE row carrying both halves. This is the case the
  // canonical-name lookup misses entirely today, leaving the card "Unknown".
  it("reads the COMBINED one-row form (ABORh Interpretation)", () => {
    expect(
      bloodTypeFromReadings([reading("ABORh Interpretation", "A POSITIVE")])
    ).toBe("A+");
    expect(bloodTypeFromReadings([reading("Blood Type", "O NEGATIVE")])).toBe(
      "O-"
    );
  });

  it("resolves the group alone when no Rh is on file", () => {
    expect(bloodTypeFromReadings([reading("ABO Blood Group", "O")])).toBe("O");
  });

  it("is null for an Rh factor alone, or no blood-group rows at all", () => {
    expect(bloodTypeFromReadings([reading("Rh Type", "POSITIVE")])).toBeNull();
    expect(bloodTypeFromReadings([])).toBeNull();
    expect(
      bloodTypeFromReadings([
        reading("Sodium", "140"),
        reading("Alanine Aminotransferase (ALT)", "22"),
      ])
    ).toBeNull();
  });

  // The name gate is what makes the loose ABO value parsing safe — a bare "A"/"B"/
  // "O" in an unrelated analyte's value must never be read as a blood group.
  it("ignores non-blood-group analytes even when their value looks like a group", () => {
    expect(
      bloodTypeFromReadings([
        reading("Hepatitis B Surface Antigen", "A POSITIVE"),
        reading("Vitamin A", "O"),
      ])
    ).toBeNull();
  });

  it("matches on the canonical name when the printed name is uninformative", () => {
    expect(
      bloodTypeFromReadings([
        { name: "Result", canonical: "ABO Blood Group", value: "B" },
      ])
    ).toBe("B");
  });

  // Straight out of a real export: "N. gonorrhoeae" CONTAINS the letters "rh". A
  // looser gate would read its "Negative" as the Rh factor and flip a real blood
  // type — and since first-match wins, record ORDER would decide. Pinned with the
  // decoy first, which is the order the real document happens to use.
  it("is not fooled by 'rh' inside an unrelated analyte name", () => {
    expect(
      bloodTypeFromReadings([
        reading("N. gonorrhoeae Amplification", "Negative"),
        reading("ABORh Interpretation", "O Positive"),
      ])
    ).toBe("O+");
    expect(
      bloodTypeFromReadings([
        reading("N. gonorrhoeae Amplification", "Negative"),
        reading("Cirrhosis Panel", "Negative"),
        reading("Diarrhea Pathogen Panel", "Negative"),
      ])
    ).toBeNull();
  });
});

describe("computeBmi", () => {
  it("computes BMI rounded to one decimal", () => {
    expect(computeBmi(70, 175)).toBe(22.9);
  });

  it("is null when weight or height is missing or non-positive", () => {
    expect(computeBmi(null, 175)).toBeNull();
    expect(computeBmi(70, null)).toBeNull();
    expect(computeBmi(70, 0)).toBeNull();
  });
});

function vital(
  partial: Partial<SummaryVital> & { name: string }
): SummaryVital {
  return {
    value: null,
    unit: null,
    flag: null,
    date: null,
    starred: false,
    ...partial,
  };
}

describe("mergeVitals", () => {
  it("dedupes by name (case-insensitive) and unions the starred flag", () => {
    const merged = mergeVitals(
      [vital({ name: "Glucose", flag: "high", value: "110" })],
      [vital({ name: "glucose", starred: true })]
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: "Glucose",
      flag: "high",
      value: "110",
      starred: true,
    });
  });

  it("orders out-of-range first, then non-optimal, then starred-normal", () => {
    const merged = mergeVitals(
      [
        vital({ name: "Normalish", flag: "non-optimal-high" }),
        vital({ name: "Bad", flag: "low" }),
      ],
      [vital({ name: "Pinned", starred: true })]
    );
    expect(merged.map((v) => v.name)).toEqual(["Bad", "Normalish", "Pinned"]);
  });
});

describe("buildProfileSummary", () => {
  const base: ProfileSummaryInput = {
    name: "Jane Doe",
    age: 40,
    ageMonths: 40 * 12,
    sex: "female",
    hasBirthdate: true,
    birthdate: "1986-01-15",
    aboValue: "O",
    rhValue: "Positive",
    manualBloodType: null,
    heightCm: 165,
    weightKg: 60,
    bodyFatPct: 24,
    restingHr: 58,
    heightDate: "2026-01-02",
    weightDate: "2026-01-03",
    bodyFatDate: "2026-01-03",
    restingHrDate: "2026-01-04",
    flagged: [vital({ name: "LDL", flag: "high", value: "160" })],
    starred: [vital({ name: "HDL", starred: true, value: "70" })],
    allergies: [],
    crossReactivity: [],
    conditions: [],
    familyHistory: [],
    medications: [
      { name: "Atorvastatin", detail: "20 mg", date: "2026-01-01" },
    ],
    supplements: [{ name: "Vitamin D", detail: "Thorne", date: "2025-12-01" }],
    immunizations: [
      {
        code: "influenza",
        name: "Influenza (Flu)",
        status: "up_to_date",
        isImmune: false,
        doses: [{ date: "2025-10-01", label: "Dose 1" }],
      },
    ],
    titers: [],
    history: [
      {
        name: "LDL",
        value: "160",
        unit: "mg/dL",
        flag: "high",
        date: "2026-01-01",
        category: "lab",
      },
    ],
  };

  it("assembles identity, body (with BMI), and passes through sections", () => {
    const s = buildProfileSummary(base);
    expect(s.identity).toMatchObject({
      name: "Jane Doe",
      age: 40,
      sex: "female",
      bloodType: "O+",
      hasBirthdate: true,
    });
    expect(s.body.bmi).toBe(22.0);
    // Adult (40 y) is out of pediatric chart range → no growth badge.
    expect(s.body.growth).toBeNull();
    expect(s.vitals.map((v) => v.name)).toEqual(["LDL", "HDL"]);
    expect(s.medications).toHaveLength(1);
    expect(s.supplements[0].name).toBe("Vitamin D");
    expect(s.immunizations[0].name).toBe("Influenza (Flu)");
    expect(s.history).toHaveLength(1);
    // Identity birthdate + per-stat body reading dates flow through verbatim.
    expect(s.identity.birthdate).toBe("1986-01-15");
    expect(s.body.weightDate).toBe("2026-01-03");
    expect(s.body.restingHrDate).toBe("2026-01-04");
  });

  it("surfaces pediatric growth percentiles for an in-range child", () => {
    const s = buildProfileSummary({
      ...base,
      age: 5,
      ageMonths: 60, // 5 y → CDC range
      sex: "male",
      heightCm: 110,
      weightKg: 18.5,
    });
    expect(s.body.growth).not.toBeNull();
    expect(s.body.growth!.heightPercentile).toBeGreaterThan(0);
    expect(s.body.growth!.weightPercentile).toBeGreaterThan(0);
    expect(s.body.growth!.bmiPercentile).toBeGreaterThan(0);
  });

  it("degrades gracefully with missing birthdate / blood type / body", () => {
    const s = buildProfileSummary({
      ...base,
      age: null,
      hasBirthdate: false,
      aboValue: null,
      rhValue: null,
      heightCm: null,
      weightKg: null,
      bodyFatPct: null,
      restingHr: null,
    });
    expect(s.identity.age).toBeNull();
    expect(s.identity.hasBirthdate).toBe(false);
    expect(s.identity.bloodType).toBeNull();
    expect(s.body.bmi).toBeNull();
  });

  it("shows the manual blood type when no ABO/Rh lab exists (#385 — matches the Emergency Card)", () => {
    const s = buildProfileSummary({
      ...base,
      aboValue: null,
      rhValue: null,
      manualBloodType: "O+",
    });
    expect(s.identity.bloodType).toBe("O+");
  });

  it("the manual blood type WINS over a lab-derived one (#385)", () => {
    const s = buildProfileSummary({
      ...base,
      aboValue: "A",
      rhValue: "Negative",
      manualBloodType: "AB+",
    });
    expect(s.identity.bloodType).toBe("AB+");
  });
});

describe("buildPassportImmunizations", () => {
  // Drive the real assessSchedule() so the passport rows share the exact status
  // logic the immunizations page uses.
  function build(
    records: { vaccine: string; date: string; dose_label?: string | null }[],
    opts: {
      ageMonths?: number | null;
      sex?: "male" | "female" | null;
      on?: string;
      titers?: { marker: string; status: TiterStatus }[];
      overrides?: VaccineOverride[];
    } = {}
  ) {
    const recs: PassportImmunizationRecord[] = records.map((r, i) => ({
      id: i + 1,
      vaccine: r.vaccine,
      date: r.date,
      dose_label: r.dose_label ?? null,
    }));
    const assessments = assessSchedule(
      recs.map((r) => ({ vaccine: r.vaccine, date: r.date })),
      opts.ageMonths ?? null,
      opts.sex ?? null,
      opts.on ?? "2026-01-01",
      opts.titers ?? [],
      opts.overrides ?? []
    ).assessments;
    return buildPassportImmunizations(recs, assessments);
  }

  it("makes one row per vaccine listing ALL dose dates oldest-first", () => {
    const rows = build([
      { vaccine: "mmr", date: "2024-06-01" },
      { vaccine: "mmr", date: "2020-05-01" },
    ]);
    // Only vaccines with a crediting dose are listed.
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe("mmr");
    expect(rows[0].doses.map((d) => d.date)).toEqual([
      "2020-05-01",
      "2024-06-01",
    ]);
    // Labels come from the shared resolveDoseLabels numbering.
    expect(rows[0].doses.map((d) => d.label)).toEqual([
      "Dose 1 of 2",
      "Dose 2 of 2",
    ]);
  });

  it("credits every component series of a combination shot", () => {
    const rows = build([{ vaccine: "twinrix", date: "2023-01-01" }]);
    expect(rows.map((r) => r.code).sort()).toEqual(["hepa", "hepb"]);
    for (const r of rows) expect(r.doses[0].date).toBe("2023-01-01");
  });

  it("keeps a titer-immune vaccine even with no dose on file", () => {
    const rows = build([], {
      titers: [{ marker: "Measles IgG", status: "immune" }],
    });
    const mmr = rows.find((r) => r.code === "mmr");
    expect(mmr).toBeTruthy();
    expect(mmr!.isImmune).toBe(true);
    expect(mmr!.doses).toHaveLength(0);
  });

  it("prefers a user-entered dose label over the auto number", () => {
    const rows = build([
      { vaccine: "tdap", date: "2022-03-01", dose_label: "Booster" },
    ]);
    const tdap = rows.find((r) => r.code === "tdap");
    expect(tdap!.doses[0].label).toBe("Booster");
  });
});
