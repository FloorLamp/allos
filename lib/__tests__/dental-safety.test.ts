import { describe, it, expect } from "vitest";
import {
  crossCheckDentalSafety,
  dentalSafetyTitle,
  dentalSafetyDetail,
  dentalSafetySignalKey,
  type PlannedDentalProcedure,
} from "@/lib/dental-safety";
import type { SafetyMedication } from "@/lib/supplement-safety";

const extraction: PlannedDentalProcedure = {
  id: 42,
  label: "Extraction · #17",
  date: "2026-08-01",
};

function med(name: string, rxcui: string | null = null): SafetyMedication {
  return { id: 1, name, rxcui, rxcuiIngredients: null };
}

describe("dental-safety cross-check (#704)", () => {
  it("bisphosphonate + planned extraction → MRONJ note", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [med("Alendronate 70 mg")],
      []
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("antiresorptive");
    expect(hits[0].note).toMatch(/osteonecrosis of the jaw|MRONJ/i);
    expect(hits[0].dedupeKey).toBe(
      dentalSafetySignalKey(42, "antiresorptive_bisphosphonate")
    );
    // Informational framing + citation on the detail.
    expect(dentalSafetyDetail(hits[0])).toMatch(/not tell you to change/i);
    expect(dentalSafetyDetail(hits[0])).toMatch(/AAOMS/);
    expect(dentalSafetyTitle(hits[0])).toMatch(/MRONJ/);
  });

  it("denosumab (antiresorptive, not a bisphosphonate) → MRONJ note", () => {
    const hits = crossCheckDentalSafety([extraction], [med("Prolia")], []);
    expect(hits.map((h) => h.gateKey)).toContain("antiresorptive_denosumab");
  });

  it("prosthetic valve condition + planned extraction → antibiotic-prophylaxis note", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [],
      ["Prosthetic aortic valve replacement"]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("cardiac");
    expect(hits[0].note).toMatch(/antibiotic prophylaxis/i);
    expect(dentalSafetyDetail(hits[0])).toMatch(/AHA/);
  });

  it("prior infective endocarditis → prophylaxis note", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [],
      ["History of infective endocarditis"]
    );
    expect(hits.map((h) => h.gateKey)).toContain("prior_endocarditis");
  });

  it("apixaban (DOAC, matched by RxCUI) + planned extraction → bleeding note", () => {
    // 1364430 is the apixaban ingredient CUI in the shared datasets — match by CUI,
    // not just name (the #482 identity discipline).
    const hits = crossCheckDentalSafety(
      [extraction],
      [med("Eliquis", "1364430")],
      []
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].gate).toBe("anticoagulant");
    expect(hits[0].note).toMatch(/bleeding/i);
  });

  it("warfarin → bleeding note", () => {
    const hits = crossCheckDentalSafety([extraction], [med("Warfarin")], []);
    expect(hits.map((h) => h.gateKey)).toContain("anticoagulant_warfarin");
  });

  it("a routine cleaning is not passed in → nothing (the invasiveness gate)", () => {
    // The gather filters non-invasive procedures out; passing an empty planned list
    // (the routine-cleaning case) yields no hits even with a bisphosphonate on file.
    expect(
      crossCheckDentalSafety([], [med("Alendronate")], ["Prosthetic valve"])
    ).toEqual([]);
  });

  it("no matching med/condition → no hit (absence is not clearance, just no flag)", () => {
    expect(
      crossCheckDentalSafety(
        [extraction],
        [med("Lisinopril")],
        ["Hypertension", "Coronary artery disease"]
      )
    ).toEqual([]);
  });

  it("a bisphosphonate AND a prosthetic valve → both notes for one procedure", () => {
    const hits = crossCheckDentalSafety(
      [extraction],
      [med("Fosamax")],
      ["Mechanical mitral valve"]
    );
    expect(new Set(hits.map((h) => h.gate))).toEqual(
      new Set(["antiresorptive", "cardiac"])
    );
    // Distinct dedupeKeys, both anchored to the same procedure id.
    expect(new Set(hits.map((h) => h.dedupeKey)).size).toBe(2);
    expect(hits.every((h) => h.procedureId === 42)).toBe(true);
  });

  it("ordinary CAD / stent / pacemaker are NOT AHA high-risk → no prophylaxis note", () => {
    expect(
      crossCheckDentalSafety(
        [extraction],
        [],
        ["Coronary artery disease", "Coronary stent", "Pacemaker"]
      )
    ).toEqual([]);
  });
});
