import { describe, expect, it } from "vitest";
import {
  parseSig,
  parsePrescription,
  cleanMedicationName,
  strengthFromName,
  looksLikeDose,
  looksLikeSig,
} from "../prescription-parse";

// The two REAL Epic strings observed on a live medications page (#2939): a
// pediatric nebulizer sig and a product/formulation string. Both used to be stored
// whole as the medication's strength.
const EPIC_SIG =
  "Take 1.5 mL (1.25 mg) by nebulization every 6 (six) hours if needed for wheezing.";
const EPIC_PRODUCT = "Amoxicillin 400 MG/5ML Suspension Reconstituted";

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

  it("'every 6 (six) hours' → 4x/day, the parenthetical ignored (#2939)", () => {
    const r = parseSig("1.5 mL every 6 (six) hours");
    expect(r.asNeeded).toBe(false);
    expect(r.timesPerDay).toBe(4);
    expect(r.amount).toBe("1.5 mL");
  });

  it("'if needed' is PRN, and the dose survives the instructions (#2939)", () => {
    const r = parseSig(EPIC_SIG);
    expect(r.asNeeded).toBe(true);
    expect(r.timesPerDay).toBeNull();
    // The sig tail never rides along into the amount.
    expect(r.amount).toBe("1.5 mL (1.25 mg)");
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

  it("accepts a concentration and a volume-with-mass-equivalent dose (#2939)", () => {
    expect(looksLikeDose("400 MG/5ML")).toBe(true);
    expect(looksLikeDose("2.5 mg/3 mL")).toBe(true);
    expect(looksLikeDose("1.5 mL (1.25 mg)")).toBe(true);
  });

  it("rejects a SENTENCE that merely contains a dose (#2939)", () => {
    // The old digit-anywhere + unit-anywhere test passed both of these, and the
    // #417 guard then stored the whole string as the strength.
    expect(looksLikeDose(EPIC_SIG)).toBe(false);
    expect(looksLikeDose(EPIC_PRODUCT)).toBe(false);
    expect(looksLikeDose("Take 1 tablet by mouth daily")).toBe(false);
  });
});

describe("looksLikeSig — the #417 routing detector (#2939)", () => {
  it("sees Epic's 'if needed' PRN phrasing", () => {
    expect(looksLikeSig("if needed for wheezing")).toBe(true);
    expect(looksLikeSig("Take 1 tab if needed for pain")).toBe(true);
  });

  it("sees an interval whose count is repeated in words", () => {
    // Epic writes the spelled-out number between the digit and the unit.
    expect(looksLikeSig("every 6 (six) hours")).toBe(true);
    expect(looksLikeSig(EPIC_SIG)).toBe(true);
  });

  it("still ignores a bare strength and empty text", () => {
    expect(looksLikeSig("500 mg")).toBe(false);
    expect(looksLikeSig(EPIC_PRODUCT)).toBe(false);
    expect(looksLikeSig(null)).toBe(false);
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

  // Issue #1026 — the parenthesized strength/concentration rendering
  // (MyChart/e-prescribing) that NAME_STRENGTH_RE's bare-digit anchor never saw.
  it("strips a parenthesized strength/concentration (#1026)", () => {
    expect(cleanMedicationName("albuterol (2.5 MG/3ML)")).toBe("albuterol");
    expect(cleanMedicationName("Insulin glargine (100 units/mL)")).toBe(
      "Insulin glargine"
    );
    expect(cleanMedicationName("Hydrocortisone (2.5%) cream")).toBe(
      "Hydrocortisone"
    );
  });

  it("strips a MID-name parenthesized strength before a form word (#1026)", () => {
    expect(cleanMedicationName("amoxicillin (400 mg/5 mL) suspension")).toBe(
      "amoxicillin"
    );
    expect(
      cleanMedicationName("albuterol (2.5 mg/3 mL) nebulizer solution")
    ).toBe("albuterol");
  });

  it("an ingredient/brand parenthetical is NEVER stripped (#1026)", () => {
    // No digit+unit pair inside the parens — this is identity, not strength.
    expect(cleanMedicationName("Tylenol (acetaminophen)")).toBe(
      "Tylenol (acetaminophen)"
    );
    expect(cleanMedicationName("Tylenol (acetaminophen) 500 mg")).toBe(
      "Tylenol (acetaminophen)"
    );
  });

  it("a parenthesized-strength-only name never strips to nothing (#1026)", () => {
    expect(cleanMedicationName("(500 mg)")).toBe("(500 mg)");
  });

  it("strips a strength parenthetical while a preceding ingredient one survives (#1026)", () => {
    // Two separate parentheticals: identity kept, strength dropped.
    expect(cleanMedicationName("Tylenol (acetaminophen) (500 mg)")).toBe(
      "Tylenol (acetaminophen)"
    );
  });

  it("a unit-only parenthetical (no number) is NOT a strength and survives (#1026)", () => {
    // No digit → not strength-shaped, so these stay put (identity/noise, not dose).
    expect(cleanMedicationName("Insulin (units)")).toBe("Insulin (units)");
    expect(cleanMedicationName("Drug (mg)")).toBe("Drug (mg)");
  });

  it("a NESTED parenthetical is left intact rather than mangled (#1026)", () => {
    // Stripping "(2.5 mg))" alone would strand a dangling "Drug (foo" — the
    // balance guard rejects that and keeps the (contrived) nested name whole.
    expect(cleanMedicationName("Drug (foo (2.5 mg))")).toBe(
      "Drug (foo (2.5 mg))"
    );
  });

  it("recovers the strength even from a nested parenthetical (#1026)", () => {
    // The name is left intact by the balance guard, but the strength is still
    // pulled out separately so the dose field is populated.
    expect(strengthFromName("Drug (foo (2.5 mg))")).toBe("2.5 mg");
  });

  it("recovers an UNBRACKETED concentration whole, denominator included (#2939)", () => {
    // The same product written with or without brackets yields the same strength.
    expect(strengthFromName("Albuterol 2.5 mg/3 mL nebulizer solution")).toBe(
      "2.5 mg/3 mL"
    );
    expect(strengthFromName("albuterol (2.5 mg/3 mL)")).toBe("2.5 mg/3 mL");
    expect(strengthFromName("Insulin glargine 100 units/mL")).toBe(
      "100 units/mL"
    );
    // A slash that starts prose is not a denominator, so the strength stops at it.
    expect(strengthFromName("Lisinopril 10 mg / do not crush")).toBe("10 mg");
  });

  it("the unparenthesized trailing strength keeps stripping as before", () => {
    expect(
      cleanMedicationName("Albuterol 2.5 mg/3 mL nebulizer solution")
    ).toBe("Albuterol");
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

  it("recovers a parenthesized concentration as the strength (#1026)", () => {
    const p = parsePrescription({
      name: "albuterol (2.5 MG/3ML)",
      value: null,
      unit: null,
      notes: null,
    });
    expect(p.name).toBe("albuterol");
    // The WHOLE concentration lands in the strength field, denominator included.
    expect(p.strength).toBe("2.5 MG/3ML");
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

  it("schedules a dose-bearing sig carried in `value` (the CCD/FHIR field) — #417", () => {
    // FHIR keeps dosageInstruction.text in `value`; the CCD path now does too.
    // "Take 1 tablet by mouth daily" is dose-SHAPED (has "1 tablet") but carries a
    // frequency, so it must be read as DIRECTIONS (scheduled daily) rather than
    // swallowed whole as the strength. Strength still comes from the name.
    const p = parsePrescription({
      name: "Lisinopril 10 mg Oral Tablet",
      value: "Take 1 tablet by mouth daily",
      unit: null,
      notes: null,
    });
    expect(p.name).toBe("Lisinopril");
    expect(p.asNeeded).toBe(false);
    expect(p.timesPerDay).toBe(1);
    expect(p.strength).toBe("10 mg");
    // The whole sentence never becomes the strength.
    expect(p.strength).not.toContain("Take");
  });

  it("prefers structured attribution over the free-text scrape — #417", () => {
    // The CCD/FHIR mappers resolve prescriber/pharmacy/Rx directly; those WIN over
    // whatever a note happens to say, so the pharmacy's own record is authoritative.
    const p = parsePrescription({
      name: "Atorvastatin 20 mg",
      value: "Take 1 tablet at bedtime",
      unit: null,
      notes: "Prescriber: Dr. Note Fallback",
      prescriber: "Dr. Ada Prescriber",
      pharmacy: "Test Pharmacy #12",
      rxNumber: "RX-555012",
    });
    expect(p.prescriber).toBe("Dr. Ada Prescriber");
    expect(p.pharmacy).toBe("Test Pharmacy #12");
    expect(p.rxNumber).toBe("RX-555012");
    expect(p.timesPerDay).toBe(1);
    expect(p.timeBuckets).toEqual(["Before sleep"]);
  });

  // #2939 — the two strings observed in production, each stored whole as the
  // medication's strength by the code these fixtures pin.
  it("keeps only the DOSE out of a real Epic nebulizer sig (#2939)", () => {
    const p = parsePrescription({ name: "albuterol", value: EPIC_SIG });
    expect(p.strength).toBe("1.5 mL (1.25 mg)");
    expect(p.strength).not.toContain("Take");
    expect(p.strength).not.toContain("wheezing");
    // "if needed" is the PRN signal, so the sentence is DIRECTIONS: it lands in the
    // sig (the item's notes) and the med is as-needed rather than scheduled.
    expect(p.sig).toBe(EPIC_SIG);
    expect(p.asNeeded).toBe(true);
    expect(p.timesPerDay).toBeNull();
  });

  it("keeps only the STRENGTH out of a product/formulation string (#2939)", () => {
    const p = parsePrescription({ name: "amoxicillin", value: EPIC_PRODUCT });
    expect(p.name).toBe("amoxicillin");
    // The concentration, denominator included — never the product name.
    expect(p.strength).toBe("400 MG/5ML");
    expect(p.strength).not.toContain("Suspension");
  });

  it("falls back to scraping a note when no structured attribution is given", () => {
    const p = parsePrescription({
      name: "Ibuprofen 200 mg",
      value: null,
      unit: null,
      notes: "Rx# A1234567. Dr. Jane Smith",
      prescriber: null,
      pharmacy: null,
      rxNumber: null,
    });
    expect(p.rxNumber).toBe("A1234567");
    expect(p.prescriber).toContain("Smith");
  });
});
