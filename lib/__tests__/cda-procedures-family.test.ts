import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";
import {
  procedureExternalId,
  familyHistoryExternalId,
} from "../clinical-parse";

// Fixture-based coverage for the two CCD clinical-list sections added here:
// Procedures (LOINC 47519-4) and Family History (LOINC 10157-6). Wraps each section
// in a minimal ClinicalDocument and asserts the extractor produces the right rows
// (name/code/date/provider for procedures; relation/condition/onset-age/deceased for
// family history), plus the stable external_id used for per-document dedup.

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

// A Procedures section: a coded colonoscopy (CPT + SNOMED translation) with a
// performed date and a performing clinician (NPI + name).
const PROCEDURES = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.7.1"/>
  <code code="47519-4" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Procedures</title>
  <text><table><tbody><tr ID="proc1"><td>Colonoscopy</td><td>05/12/2024</td></tr></tbody></table></text>
  <entry><procedure classCode="PROC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.14"/>
    <id root="1.2.3" extension="proc-001"/>
    <code code="45378" codeSystem="2.16.840.1.113883.6.12" displayName="Colonoscopy">
      <translation code="73761001" codeSystem="2.16.840.1.113883.6.96" displayName="Colonoscopy"/>
    </code>
    <statusCode code="completed"/>
    <effectiveTime value="20240512"/>
    <performer typeCode="PRF"><assignedEntity>
      <id root="2.16.840.1.113883.4.6" extension="9999999995"/>
      <assignedPerson><name><given>Testy</given><family>Provider</family></name></assignedPerson>
    </assignedEntity></performer>
  </procedure></entry>
</section>`;

// A Family History section: one organizer (Father) carrying two conditions — Type 2
// diabetes with an age-of-onset observation, and Coronary artery disease with a
// nested Death observation (SNOMED "Dead" 419099009).
const FAMILY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.15"/>
  <code code="10157-6" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Family History</title>
  <entry><organizer classCode="CLUSTER" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.45"/>
    <statusCode code="completed"/>
    <subject><relatedSubject classCode="PRS">
      <code code="FTH" codeSystem="2.16.840.1.113883.5.111" displayName="Father"/>
    </relatedSubject></subject>
    <component><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.46"/>
      <code code="64572001" codeSystem="2.16.840.1.113883.6.96" displayName="Condition"/>
      <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96" displayName="Type 2 diabetes mellitus"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.31"/>
        <code code="445518008" codeSystem="2.16.840.1.113883.6.96" displayName="Age at onset"/>
        <value xsi:type="PQ" value="55" unit="a"/>
      </observation></entryRelationship>
    </observation></component>
    <component><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.46"/>
      <code code="64572001" codeSystem="2.16.840.1.113883.6.96" displayName="Condition"/>
      <value xsi:type="CD" code="53741008" codeSystem="2.16.840.1.113883.6.96" displayName="Coronary arteriosclerosis"/>
      <entryRelationship typeCode="CAUS"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.47"/>
        <code code="ASSERTION" codeSystem="2.16.840.1.113883.5.4"/>
        <value xsi:type="CD" code="419099009" codeSystem="2.16.840.1.113883.6.96" displayName="Dead"/>
      </observation></entryRelationship>
    </observation></component>
  </organizer></entry>
</section>`;

describe("CCD Procedures → ImportedProcedure", () => {
  it("maps name, code (CPT preferred), date, and performer", () => {
    const r = extractFromCcda(doc(PROCEDURES));
    expect(r.procedures).toHaveLength(1);
    const p = r.procedures![0];
    expect(p).toMatchObject({
      name: "Colonoscopy",
      code: "45378",
      code_system: "CPT",
      date: "2024-05-12",
    });
    expect(p.provider?.name).toContain("Provider");
    expect(p.external_id).toBe(
      procedureExternalId({
        name: "Colonoscopy",
        code: "45378",
        date: "2024-05-12",
      })
    );
    // The Procedures section registers as consumed in the coverage report.
    const cov = r.report!.coverage.find((c) => c.title === "Procedures");
    expect(cov?.consumed).toBe(true);
  });
});

describe("CCD Family History → ImportedFamilyHistory", () => {
  it("maps relation, one row per condition, onset age, and deceased", () => {
    const r = extractFromCcda(doc(FAMILY));
    expect(r.familyHistory).toHaveLength(2);
    const diabetes = r.familyHistory!.find((f) =>
      /diabetes/i.test(f.condition)
    )!;
    expect(diabetes).toMatchObject({
      relation: "Father",
      code: "44054006",
      code_system: "SNOMED CT",
      onset_age: 55,
    });
    expect(diabetes.external_id).toBe(
      familyHistoryExternalId({
        relation: "Father",
        condition: diabetes.condition,
        code: "44054006",
      })
    );
    // The CAD row carries the deceased flag from the nested Death observation.
    const cad = r.familyHistory!.find((f) => /coronary/i.test(f.condition))!;
    expect(cad.relation).toBe("Father");
    expect(cad.deceased).toBe(1);
    const cov = r.report!.coverage.find((c) => c.title === "Family History");
    expect(cov?.consumed).toBe(true);
  });
});
