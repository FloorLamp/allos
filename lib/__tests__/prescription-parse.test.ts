import { describe, expect, it } from "vitest";
import {
  parseSig,
  parsePrescription,
  cleanMedicationName,
  looksLikeDose,
} from "../prescription-parse";

// Pure parsing of an extracted prescription into structured medication fields
//. No DB — the DB routing/dedup is exercised separately.

describe("parseSig — sig/frequency → schedule", () => {
  it("'1 tab PO daily' → scheduled once daily, route stripped", () => {
    const r = parseSig("1 tab PO daily");
    expect(r.asNeeded).toBe(false);
    expect(r.timesPerDay).toBe(1);
    expect(r.amount).toBe("1 tab"); // "PO" route removed
    expect(r.timeBuckets).toHaveLength(1);
  });

  it("'take 2 tablets twice daily' → scheduled twice daily, verb stripped", () => {
    const r = parseSig("take 2 tablets twice daily");
    expect(r.asNeeded).toBe(false);
    expect(r.timesPerDay).toBe(2);
    expect(r.amount).toBe("2 tablets");
    expect(r.timeBuckets).toEqual(["Morning", "Evening"]);
  });

  it("'as needed for pain' → PRN, no schedule, no fabricated dose", () => {
    const r = parseSig("as needed for pain");
    expect(r.asNeeded).toBe(true);
    expect(r.timesPerDay).toBeNull();
    expect(r.amount).toBeNull(); // "for pain" is not a dose
    expect(r.timeBuckets).toEqual([]);
  });

  it("'every 8 hours' → 3x/day interval schedule", () => {
    const r = parseSig("every 8 hours");
    expect(r.asNeeded).toBe(false);
    expect(r.timesPerDay).toBe(3); // 24 / 8
    expect(r.timeBuckets).toEqual(["Morning", "Midday", "Evening"]);
  });

  it("'every 12 hours' → 2x/day; 'every 6 hours' → 4x/day", () => {
    expect(parseSig("every 12 hours").timesPerDay).toBe(2);
    expect(parseSig("every 6 hours").timesPerDay).toBe(4);
    expect(parseSig("q8h").timesPerDay).toBe(3);
  });

  it("'1 tablet three times daily' (tid) → 3x/day", () => {
    expect(parseSig("1 tablet three times daily").timesPerDay).toBe(3);
    expect(parseSig("1 cap tid").timesPerDay).toBe(3);
  });

  it("keeps a strength but no schedule for a dose-only, frequency-less sig", () => {
    // "10 mg" states a dose but NO frequency — don't invent daily; go unscheduled.
    const r = parseSig("10 mg");
    expect(r.asNeeded).toBe(true);
    expect(r.timesPerDay).toBeNull();
    expect(r.amount).toBe("10 mg");
  });

  it("an empty / whitespace sig is unscheduled (as-needed)", () => {
    for (const s of [null, undefined, "", "   "]) {
      const r = parseSig(s as string | null);
      expect(r.asNeeded).toBe(true);
      expect(r.timesPerDay).toBeNull();
    }
  });

  it("an unparseable free-text sig is unscheduled, never a wrong daily", () => {
    const r = parseSig("continue current regimen per cardiology");
    expect(r.asNeeded).toBe(true);
    expect(r.timesPerDay).toBeNull();
  });

  it("infers an evening bucket from a timing word", () => {
    const r = parseSig("1 tablet at bedtime");
    expect(r.asNeeded).toBe(false);
    expect(r.timesPerDay).toBe(1);
    expect(r.timeBuckets).toEqual(["Before sleep"]);
  });
});

describe("looksLikeDose", () => {
  it("accepts number+unit / number+form", () => {
    expect(looksLikeDose("10 mg")).toBe(true);
    expect(looksLikeDose("1 tab")).toBe(true);
    expect(looksLikeDose("2 tablets")).toBe(true);
    expect(looksLikeDose("5 mL")).toBe(true);
    expect(looksLikeDose("81mg")).toBe(true);
  });
  it("rejects prose / bare numbers / bare words", () => {
    expect(looksLikeDose("every")).toBe(false);
    expect(looksLikeDose("as needed for pain")).toBe(false);
    expect(looksLikeDose("10")).toBe(false);
    expect(looksLikeDose(null)).toBe(false);
    expect(looksLikeDose("")).toBe(false);
  });
});

describe("cleanMedicationName — grouping name", () => {
  it("strips a trailing strength so an extracted name dedups against a manual one", () => {
    expect(cleanMedicationName("Lisinopril 10 mg")).toBe("Lisinopril");
    expect(cleanMedicationName("Metformin 500mg tablet")).toBe("Metformin");
    expect(cleanMedicationName("Atorvastatin 20 MG Tablet")).toBe(
      "Atorvastatin"
    );
  });
  it("strips a percent strength (with or without a trailing form)", () => {
    // `%` is a non-word char, so a `%\b`-style regex can never match a real
    // percent strength — this pins the fixed alternation (#272).
    expect(cleanMedicationName("Hydrocortisone 2.5%")).toBe("Hydrocortisone");
    expect(cleanMedicationName("Hydrocortisone 2.5% Cream")).toBe(
      "Hydrocortisone"
    );
    expect(cleanMedicationName("Ketoconazole 2% Shampoo")).toBe("Ketoconazole");
  });
  it("leaves a bare drug name untouched", () => {
    expect(cleanMedicationName("Lisinopril")).toBe("Lisinopril");
    expect(cleanMedicationName("  Aspirin  ")).toBe("Aspirin");
  });
  it("never strips the name down to nothing", () => {
    expect(cleanMedicationName("500 mg")).toBe("500 mg");
  });
});

describe("parsePrescription — full record → structured med", () => {
  it("splits strength from name and parses the sig", () => {
    const p = parsePrescription({
      name: "Lisinopril 10 mg",
      value: null,
      unit: null,
      notes: "1 tab PO daily",
    });
    expect(p.name).toBe("Lisinopril");
    expect(p.strength).toBe("10 mg");
    expect(p.asNeeded).toBe(false);
    expect(p.timesPerDay).toBe(1);
  });

  it("recovers a percent strength packed into the name (#272)", () => {
    const p = parsePrescription({
      name: "Hydrocortisone 2.5% Cream",
      value: null,
      unit: null,
      notes: "apply to affected area twice daily",
    });
    expect(p.name).toBe("Hydrocortisone");
    expect(p.strength).toBe("2.5%");
    expect(p.timesPerDay).toBe(2);
  });

  it("takes strength from value+unit when present", () => {
    const p = parsePrescription({
      name: "Metformin",
      value: "500",
      unit: "mg",
      notes: "take 2 tablets twice daily",
    });
    expect(p.name).toBe("Metformin");
    expect(p.strength).toBe("500 mg");
    expect(p.timesPerDay).toBe(2);
    expect(p.asNeeded).toBe(false);
  });

  it("does not treat a bare strength value as a sig (stays unscheduled)", () => {
    const p = parsePrescription({
      name: "Amoxicillin",
      value: "500 mg",
      unit: null,
      notes: null,
    });
    expect(p.strength).toBe("500 mg");
    expect(p.asNeeded).toBe(true); // no frequency anywhere
    expect(p.timesPerDay).toBeNull();
  });

  it("marks a PRN med as-needed and captures a labelled Rx / prescriber", () => {
    const p = parsePrescription({
      name: "Ibuprofen 200 mg",
      value: null,
      unit: null,
      notes: "Take as needed for pain. Rx# A1234567. Dr. Jane Smith",
    });
    expect(p.name).toBe("Ibuprofen");
    expect(p.asNeeded).toBe(true);
    expect(p.timesPerDay).toBeNull();
    expect(p.rxNumber).toBe("A1234567");
    expect(p.prescriber).toContain("Smith");
  });

  it("carries an interval sig into a real schedule", () => {
    const p = parsePrescription({
      name: "Amoxicillin",
      value: "500 mg",
      unit: null,
      notes: "1 capsule every 8 hours",
    });
    expect(p.timesPerDay).toBe(3);
    expect(p.asNeeded).toBe(false);
    expect(p.strength).toBe("500 mg");
  });
});
