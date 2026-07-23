import { describe, it, expect } from "vitest";
import { medNameKey, MED_BRIDGE_PREFIX } from "@/lib/medication-record-match";

// The record↔med matcher + bridge generators were removed with the "From your records"
// bridge (#1270); what survives is the shared name-collapse key and the RETIRED
// dismissal prefix. See lib/__tests__/suppression-display.test.ts and
// lib/__db_tests__/suppressed-center.test.ts for the orphan-dismissal labeling/clearing
// path that keeps MED_BRIDGE_PREFIX alive (#203).

describe("medNameKey", () => {
  it("strips a trailing strength/form and lowercases", () => {
    expect(medNameKey("Lisinopril 10 mg")).toBe("lisinopril");
    expect(medNameKey("Atorvastatin 20mg tablet")).toBe("atorvastatin");
  });

  it("collapses a brand label to its generic key", () => {
    expect(medNameKey("Tylenol 500 mg")).toBe("acetaminophen");
    expect(medNameKey("Advil")).toBe("ibuprofen");
  });
});

describe("MED_BRIDGE_PREFIX (retired, #1270)", () => {
  it("keeps its historical namespace so stored dismissals still resolve (#203)", () => {
    // The value must NOT drift — a stored `med-bridge:<name>` row from a pre-removal
    // instance is labeled/cleared by the suppressed-center resolver off this exact
    // prefix.
    expect(MED_BRIDGE_PREFIX).toBe("med-bridge:");
  });
});
