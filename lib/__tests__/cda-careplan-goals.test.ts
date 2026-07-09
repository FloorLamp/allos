import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";
import { carePlanExternalId, careGoalExternalId } from "../clinical-parse";

// Fixture-based coverage for the two CCD sections added here: Plan of Treatment /
// Care Plan (LOINC 18776-5) and Goals (LOINC 61146-7). Each section is wrapped in a
// minimal ClinicalDocument and the extractor is asserted to produce the right rows
// (description / category / planned date / status for care plan; description /
// target date / status for goals), plus the stable external_id used for per-
// document dedup and the consumed coverage flag. All data is obviously synthetic.

function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
    <administrativeGenderCode code="F"/>
    <birthTime value="19860115"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

// A Plan of Treatment section: a planned observation (lipid panel), a planned
// procedure (colonoscopy), and a planned encounter (follow-up visit).
const CARE_PLAN = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.10.1"/>
  <code code="18776-5" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Plan of Treatment</title>
  <entry><observation classCode="OBS" moodCode="RQO">
    <code code="57698-3" codeSystem="2.16.840.1.113883.6.1" displayName="Lipid panel"/>
    <statusCode code="active"/>
    <effectiveTime value="20250115"/>
  </observation></entry>
  <entry><procedure classCode="PROC" moodCode="INT">
    <code code="45378" codeSystem="2.16.840.1.113883.6.12" displayName="Colonoscopy"/>
    <statusCode code="active"/>
    <effectiveTime><low value="20250601"/></effectiveTime>
  </procedure></entry>
  <entry><encounter classCode="ENC" moodCode="ARQ">
    <code code="11816003" codeSystem="2.16.840.1.113883.6.96" displayName="Dietary regime"/>
    <statusCode code="new"/>
  </encounter></entry>
</section>`;

// A Goals section: two Goal Observations (4.121) with target dates + statuses.
const GOALS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.60"/>
  <code code="61146-7" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Goals</title>
  <entry><observation classCode="OBS" moodCode="GOL">
    <templateId root="2.16.840.1.113883.10.20.22.4.121"/>
    <code code="4548-4" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin A1c below 6.5%"/>
    <statusCode code="active"/>
    <effectiveTime value="20250901"/>
  </observation></entry>
  <entry><observation classCode="OBS" moodCode="GOL">
    <templateId root="2.16.840.1.113883.10.20.22.4.121"/>
    <code code="85354-9" codeSystem="2.16.840.1.113883.6.1" displayName="Blood pressure under 130/80"/>
    <statusCode code="active"/>
  </observation></entry>
</section>`;

describe("CCD Plan of Treatment → ImportedCarePlanItem", () => {
  it("maps description, category, planned date, and status per planned entry", () => {
    const r = extractFromCcda(doc(CARE_PLAN));
    expect(r.carePlanItems).toHaveLength(3);
    const lipid = r.carePlanItems!.find((c) => /lipid/i.test(c.description))!;
    expect(lipid).toMatchObject({
      description: "Lipid panel",
      code: "57698-3",
      category: "observation",
      planned_date: "2025-01-15",
      status: "active",
    });
    expect(lipid.external_id).toBe(
      carePlanExternalId({
        description: "Lipid panel",
        code: "57698-3",
        plannedDate: "2025-01-15",
      })
    );
    const colo = r.carePlanItems!.find((c) =>
      /colonoscopy/i.test(c.description)
    )!;
    expect(colo).toMatchObject({
      category: "procedure",
      planned_date: "2025-06-01", // effectiveTime period low
    });
    const visit = r.carePlanItems!.find((c) => c.category === "encounter")!;
    expect(visit.planned_date).toBeNull();
    // The section registers as consumed in the coverage report.
    const cov = r.report!.coverage.find((c) => c.title === "Plan of Treatment");
    expect(cov?.consumed).toBe(true);
  });
});

describe("CCD Goals → ImportedCareGoal", () => {
  it("maps description, target date, and status", () => {
    const r = extractFromCcda(doc(GOALS));
    expect(r.careGoals).toHaveLength(2);
    const a1c = r.careGoals!.find((g) => /a1c/i.test(g.description))!;
    expect(a1c).toMatchObject({
      description: "Hemoglobin A1c below 6.5%",
      code: "4548-4",
      target_date: "2025-09-01",
      status: "active",
    });
    expect(a1c.external_id).toBe(
      careGoalExternalId({
        description: "Hemoglobin A1c below 6.5%",
        code: "4548-4",
        targetDate: "2025-09-01",
      })
    );
    const bp = r.careGoals!.find((g) => /blood pressure/i.test(g.description))!;
    expect(bp.target_date).toBeNull();
    const cov = r.report!.coverage.find((c) => c.title === "Goals");
    expect(cov?.consumed).toBe(true);
  });
});
