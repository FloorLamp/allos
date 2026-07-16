import { describe, it, expect } from "vitest";
import {
  recordMatchesMed,
  unmatchedPrescriptionRecords,
  recordMedKey,
  recordDisplayName,
  medBridgeDismissalKey,
  MED_BRIDGE_PREFIX,
  type TrackedMedLike,
} from "@/lib/medication-record-match";

describe("recordDisplayName", () => {
  it("prefers the canonical (cleaned) name, falls back to the raw name", () => {
    expect(
      recordDisplayName({
        name: "AMOXICILLIN 500 MG",
        canonical_name: "Amoxicillin",
      })
    ).toBe("Amoxicillin");
    expect(recordDisplayName({ name: "Amoxicillin 500 mg" })).toBe(
      "Amoxicillin 500 mg"
    );
    expect(
      recordDisplayName({ name: "Lisinopril", canonical_name: "  " })
    ).toBe("Lisinopril");
  });
});

describe("recordMedKey", () => {
  it("strips a trailing strength and lowercases", () => {
    expect(recordMedKey({ name: "Lisinopril 10 mg" })).toBe("lisinopril");
    expect(recordMedKey({ name: "Atorvastatin 20mg tablet" })).toBe(
      "atorvastatin"
    );
  });

  it("collapses a brand label to its generic key", () => {
    expect(recordMedKey({ name: "Tylenol 500 mg" })).toBe("acetaminophen");
    expect(recordMedKey({ name: "Advil" })).toBe("ibuprofen");
  });
});

describe("recordMatchesMed", () => {
  const med: TrackedMedLike = { name: "Lisinopril", brand: null };

  it("matches by cleaned name across a strength suffix", () => {
    expect(recordMatchesMed({ name: "Lisinopril 10 mg" }, med)).toBe(true);
    expect(recordMatchesMed({ name: "lisinopril" }, med)).toBe(true);
  });

  it("does not match a different drug", () => {
    expect(recordMatchesMed({ name: "Metformin 500 mg" }, med)).toBe(false);
  });

  it("matches a branded record against a generic tracked med", () => {
    const acetaminophen: TrackedMedLike = { name: "Acetaminophen" };
    expect(recordMatchesMed({ name: "Tylenol 500 mg" }, acetaminophen)).toBe(
      true
    );
  });

  it("matches a generic record against a tracked med recorded under its brand", () => {
    const branded: TrackedMedLike = { name: "Advil", brand: "Advil" };
    expect(recordMatchesMed({ name: "Ibuprofen 200 mg" }, branded)).toBe(true);
  });

  it("matches by RxCUI first when both sides carry a code (#279)", () => {
    const coded: TrackedMedLike = {
      name: "Something Else Entirely",
      rxcui: "617314",
    };
    // Names disagree, but the shared product CUI wins.
    expect(
      recordMatchesMed({ name: "Atorvastatin", rxcui: "617314" }, coded)
    ).toBe(true);
  });

  it("matches by an ingredient CUI when the product code differs", () => {
    const coded: TrackedMedLike = {
      name: "Combo Product",
      rxcui: "999999",
      rxcuiIngredients: ["161", "5640"],
    };
    expect(recordMatchesMed({ name: "Combo", rxcui: "5640" }, coded)).toBe(
      true
    );
  });
});

describe("unmatchedPrescriptionRecords", () => {
  it("drops records that are already tracked (active or paused)", () => {
    const meds: TrackedMedLike[] = [
      { name: "Lisinopril" },
      { name: "Metformin 500 mg" },
    ];
    const records = [
      { name: "Lisinopril 10 mg", canonical_name: "Lisinopril" },
      { name: "Amoxicillin 500 mg", canonical_name: "Amoxicillin" },
      { name: "Metformin", canonical_name: "Metformin" },
    ];
    const out = unmatchedPrescriptionRecords(records, meds);
    expect(out.map((r) => r.canonical_name)).toEqual(["Amoxicillin"]);
  });

  it("collapses duplicate records for the same drug to the first", () => {
    const records = [
      {
        name: "Amoxicillin 500 mg",
        canonical_name: "Amoxicillin",
        date: "2026-06-01",
      },
      {
        name: "Amoxicillin",
        canonical_name: "Amoxicillin",
        date: "2025-01-01",
      },
    ];
    const out = unmatchedPrescriptionRecords(records, []);
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-06-01");
  });

  it("returns every record when nothing is tracked", () => {
    const records = [
      { name: "Amoxicillin", canonical_name: "Amoxicillin" },
      { name: "Ibuprofen", canonical_name: "Ibuprofen" },
    ];
    expect(unmatchedPrescriptionRecords(records, [])).toHaveLength(2);
  });
});

describe("medBridgeDismissalKey", () => {
  it("is name-keyed under the med-bridge namespace", () => {
    const key = medBridgeDismissalKey({
      name: "Amoxicillin 500 mg",
      canonical_name: "Amoxicillin",
    });
    expect(key).toBe(`${MED_BRIDGE_PREFIX}amoxicillin`);
  });

  it("is stable across a strength/brand relabel of the same drug", () => {
    expect(medBridgeDismissalKey({ name: "Tylenol" })).toBe(
      medBridgeDismissalKey({ name: "Acetaminophen 500 mg" })
    );
  });
});
