// DB INTEGRATION TIER — the dental-procedure safety cross-check builder (#704), per
// the #448 findings-builder-test discipline.
//
// getDentalSafetyWarnings is a findings BUILDER: it GATHERS DB state (the profile's
// PLANNED INVASIVE dental_procedures + the shared active-med/condition gather
// getIntakeSafetyContext) and hands it to the pure engine (crossCheckDentalSafety).
// The pure tier (lib/__tests__/dental-safety.test.ts) takes pre-gathered arrays and
// structurally can't see a gather bug (a non-invasive procedure slipping through, the
// wrong med set, a completed-vs-planned status) — so this seeds a realistic fixture
// and asserts the END-TO-END finding, INCLUDING the invasiveness gate (#704 ask 4:
// a routine cleaning triggers nothing).
//
// It also pins "one question, one computation": the SAME fixture yields the SAME
// finding on the dismissible Upcoming surface (collectUpcoming) as the gather.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  getDentalSafetyWarnings,
  collectUpcoming,
  dismissFinding,
} from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addDental(
  profileId: number,
  name: string,
  status: string,
  cdt: string | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO dental_procedures (profile_id, name, status, cdt_code, procedure_date)
         VALUES (?, ?, ?, ?, '2099-01-01')`
      )
      .run(profileId, name, status, cdt).lastInsertRowid
  );
}

function addMedication(
  profileId: number,
  name: string,
  rxcui: string | null = null
): void {
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, rxcui)
     VALUES (?, ?, 1, 'medication', ?)`
  ).run(profileId, name, rxcui);
}

function addCondition(profileId: number, name: string): void {
  db.prepare(
    `INSERT INTO conditions (profile_id, name, status) VALUES (?, ?, 'active')`
  ).run(profileId, name);
}

describe("getDentalSafetyWarnings — planned invasive dental × meds/conditions (#704)", () => {
  it("flags MRONJ (bisphosphonate) on both surfaces for a planned extraction", () => {
    const profileId = makeProfile("dental-mronj");
    const dpId = addDental(profileId, "Extraction of tooth #17", "planned");
    addMedication(profileId, "Alendronate 70 mg");

    const warnings = getDentalSafetyWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].gate).toBe("antiresorptive");
    expect(warnings[0].dedupeKey).toBe(
      `dental-safety:${dpId}:antiresorptive_bisphosphonate`
    );

    // Surface 2: the dismissible Upcoming finding — same dedupeKey.
    const up = collectUpcoming(profileId).find(
      (i) => i.domain === "dental-safety"
    );
    expect(up?.key).toBe(warnings[0].dedupeKey);
    expect(up?.band).toBe("today"); // care-tier → Needs-attention hero

    // Dismissing it silences the Upcoming finding ("dismiss once, silence everywhere").
    dismissFinding(profileId, warnings[0].dedupeKey);
    expect(
      collectUpcoming(profileId).some((i) => i.domain === "dental-safety")
    ).toBe(false);
  });

  it("flags AHA antibiotic prophylaxis for a prosthetic valve × planned implant", () => {
    const profileId = makeProfile("dental-prophylaxis");
    addDental(profileId, "Implant placement", "planned", "D6010");
    addCondition(profileId, "Prosthetic aortic valve replacement");

    const warnings = getDentalSafetyWarnings(profileId);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].gate).toBe("cardiac");
    expect(warnings[0].note).toMatch(/antibiotic prophylaxis/i);
  });

  it("flags bleeding for an anticoagulant × planned surgical extraction", () => {
    const profileId = makeProfile("dental-bleeding");
    addDental(profileId, "Surgical extraction #32", "planned");
    addMedication(profileId, "Eliquis", "1364430"); // apixaban ingredient CUI

    const warnings = getDentalSafetyWarnings(profileId);
    expect(warnings.map((w) => w.gate)).toContain("anticoagulant");
  });

  it("a routine cleaning (non-invasive) triggers NOTHING even with a bisphosphonate on file", () => {
    const profileId = makeProfile("dental-cleaning-noflag");
    addDental(profileId, "Adult prophylaxis (cleaning)", "planned", "D1110");
    addMedication(profileId, "Alendronate");
    addCondition(profileId, "Prosthetic mitral valve");

    expect(getDentalSafetyWarnings(profileId)).toEqual([]);
    expect(
      collectUpcoming(profileId).some((i) => i.domain === "dental-safety")
    ).toBe(false);
  });

  it("a COMPLETED invasive procedure is not a planned trigger", () => {
    const profileId = makeProfile("dental-completed-noflag");
    addDental(profileId, "Extraction of tooth #14", "completed");
    addMedication(profileId, "Alendronate");
    expect(getDentalSafetyWarnings(profileId)).toEqual([]);
  });

  it("a planned invasive procedure with no matching med/condition → no flag", () => {
    const profileId = makeProfile("dental-noflag");
    addDental(profileId, "Extraction", "planned");
    addMedication(profileId, "Lisinopril");
    addCondition(profileId, "Hypertension");
    expect(getDentalSafetyWarnings(profileId)).toEqual([]);
  });
});
