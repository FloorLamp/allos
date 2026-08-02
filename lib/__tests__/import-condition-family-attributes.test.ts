// PURE TIER — the deterministic importers stop dropping what they already parse
// (issues #1403 / #1407).
//
// Both source formats CARRY these facts today: CCD in the Problem Severity
// observation / targetSiteCode and the Family History death + age observations, FHIR
// in Condition.severity / .bodySite / .stage and FamilyMemberHistory.deceasedAge /
// condition.contributedToDeath / relationship. Every one of them used to land on the
// floor. These tests pin that they now reach the projection — and that a source
// which states nothing still states nothing (no inferred side, no invented cause).

import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";
import { parseFhirBundle } from "../fhir";

function ccdaDoc(...sections: string[]): string {
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

// A Problems section carrying a SIDED, GRADED problem: targetSiteCode names the left
// knee, and a nested Severity Observation (4.8) codes SNOMED "moderate".
const SIDED_PROBLEM = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ">
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <code code="55607006" codeSystem="2.16.840.1.113883.6.96" displayName="Problem"/>
        <statusCode code="completed"/>
        <effectiveTime><low value="20210604"/></effectiveTime>
        <value xsi:type="CD" code="239873007"
               codeSystem="2.16.840.1.113883.6.96"
               displayName="Osteoarthritis of knee"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
        <targetSiteCode code="72696002" codeSystem="2.16.840.1.113883.6.96"
                        displayName="Knee region structure">
          <qualifier>
            <name code="272741003" displayName="Laterality"/>
            <value code="7771000" codeSystem="2.16.840.1.113883.6.96" displayName="Left"/>
          </qualifier>
        </targetSiteCode>
        <entryRelationship typeCode="SUBJ">
          <observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.8"/>
            <code code="SEV" displayName="Severity"/>
            <value xsi:type="CD" code="6736007"
                   codeSystem="2.16.840.1.113883.6.96" displayName="Moderate"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
          </observation>
        </entryRelationship>
      </observation>
    </entryRelationship>
  </act></entry>
</section>`;

// A Problems section with NO side and NO grade — the control.
const PLAIN_PROBLEM = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ">
      <observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <statusCode code="completed"/>
        <value xsi:type="CD" code="73211009"
               codeSystem="2.16.840.1.113883.6.96" displayName="Diabetes mellitus"
               xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
      </observation>
    </entryRelationship>
  </act></entry>
</section>`;

// A Family History section: a NATURAL father (NMTH-style role code NFTH) who died,
// with an Age Observation nested under the Death Observation.
const FAMILY_HISTORY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.15"/>
  <code code="10157-6" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"/>
  <title>Family History</title>
  <entry><organizer classCode="CLUSTER" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.45"/>
    <statusCode code="completed"/>
    <subject><relatedSubject classCode="PRS">
      <code code="NFTH" codeSystem="2.16.840.1.113883.5.111" displayName="Natural father"/>
    </relatedSubject></subject>
    <component><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.46"/>
      <statusCode code="completed"/>
      <value xsi:type="CD" code="53741008" codeSystem="2.16.840.1.113883.6.96"
             displayName="Coronary artery disease"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
      <entryRelationship typeCode="SUBJ">
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.31"/>
          <value xsi:type="PQ" value="62" unit="a"
                 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
        </observation>
      </entryRelationship>
    </observation></component>
    <component><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.47"/>
      <value xsi:type="CD" code="419099009" codeSystem="2.16.840.1.113883.6.96"
             displayName="Dead" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
      <entryRelationship typeCode="SUBJ">
        <observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.31"/>
          <value xsi:type="PQ" value="68" unit="a"
                 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>
        </observation>
      </entryRelationship>
    </observation></component>
  </organizer></entry>
</section>`;

function fhirBundle(...resources: Record<string, unknown>[]) {
  return JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: resources.map((resource) => ({ resource })),
  });
}

describe("CCD problem attributes (#1403)", () => {
  it("keeps the side from targetSiteCode and the grade from the severity observation", () => {
    const r = extractFromCcda(ccdaDoc(SIDED_PROBLEM));
    const c = r.conditions!.find((x) => /osteoarthritis/i.test(x.name))!;
    expect(c.laterality).toBe("left");
    expect(c.severity).toBe("moderate");
  });

  it("leaves both unstated when the document states neither", () => {
    const r = extractFromCcda(ccdaDoc(PLAIN_PROBLEM));
    const c = r.conditions![0];
    expect(c.laterality ?? null).toBeNull();
    expect(c.severity ?? null).toBeNull();
  });
});

describe("CCD family history attributes (#1407)", () => {
  it("keeps the age at death and reads the genetic axis off the role code", () => {
    const r = extractFromCcda(ccdaDoc(FAMILY_HISTORY));
    const f = r.familyHistory![0];
    expect(f).toMatchObject({
      relation: "Natural father",
      onset_age: 62,
      deceased: 1,
      age_at_death: 68,
      relation_type: "genetic",
    });
    // CCD's death observation asserts THAT, not of what — nothing is invented.
    expect(f.cause_of_death ?? null).toBeNull();
  });
});

describe("FHIR Condition attributes (#1403)", () => {
  it("maps severity, bodySite laterality and stage.summary", () => {
    const r = parseFhirBundle(
      fhirBundle({
        resourceType: "Condition",
        code: { text: "Invasive ductal carcinoma" },
        clinicalStatus: { coding: [{ code: "active" }] },
        severity: {
          coding: [{ system: "http://snomed.info/sct", code: "24484000" }],
        },
        bodySite: [{ text: "Structure of left breast" }],
        stage: [{ summary: { text: "Stage IIIA" } }],
      })
    );
    expect(r.conditions![0]).toMatchObject({
      laterality: "left",
      severity: "severe",
      stage: "Stage IIIA",
    });
  });

  it("never infers a side from the condition NAME alone", () => {
    const r = parseFhirBundle(
      fhirBundle({
        resourceType: "Condition",
        code: { text: "Osteoarthritis of left knee" },
        clinicalStatus: { coding: [{ code: "active" }] },
      })
    );
    // The name says it; the SOURCE never stated a bodySite, so the column stays
    // unstated rather than carrying a parsed-from-prose claim.
    expect(r.conditions![0].laterality ?? null).toBeNull();
  });
});

describe("FHIR FamilyMemberHistory attributes (#1407)", () => {
  it("maps deceasedAge, contributedToDeath and a step relationship", () => {
    const r = parseFhirBundle(
      fhirBundle({
        resourceType: "FamilyMemberHistory",
        status: "completed",
        relationship: {
          text: "Stepfather",
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
              code: "STPFTH",
            },
          ],
        },
        deceasedAge: { value: 61, unit: "a" },
        condition: [
          {
            code: { text: "Myocardial infarction" },
            contributedToDeath: true,
          },
        ],
      })
    );
    expect(r.familyHistory![0]).toMatchObject({
      relation: "Stepfather",
      deceased: 1,
      age_at_death: 61,
      cause_of_death: "Myocardial infarction",
      relation_type: "step",
    });
  });

  it("reads the maternal line off a grandparent role code", () => {
    const r = parseFhirBundle(
      fhirBundle({
        resourceType: "FamilyMemberHistory",
        status: "completed",
        relationship: {
          text: "Grandmother",
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v3-RoleCode",
              code: "MGRMTH",
            },
          ],
        },
        condition: [{ code: { text: "Colorectal cancer" } }],
      })
    );
    expect(r.familyHistory![0].lineage).toBe("maternal");
    expect(r.familyHistory![0].relation_type ?? null).toBeNull();
  });
});
