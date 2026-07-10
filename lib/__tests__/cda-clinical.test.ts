import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// Wrap section XML in a minimal ClinicalDocument so extractFromCcda can walk it.
function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

const REAL_ALLERGY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.6.1"/>
  <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Allergies</title>
  <text><content ID="a1">Penicillin</content></text>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
      <effectiveTime><low value="20180101"/></effectiveTime>
      <value xsi:type="CD" code="416098002" codeSystem="2.16.840.1.113883.6.96" displayName="Drug allergy"/>
      <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
        <code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin"/>
      </playingEntity></participantRole></participant>
      <entryRelationship typeCode="MFST"><observation classCode="OBS" moodCode="EVN">
        <value xsi:type="CD" code="247472004" codeSystem="2.16.840.1.113883.6.96" displayName="Hives"/>
      </observation></entryRelationship>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.8"/>
        <value xsi:type="CD" code="6736007" codeSystem="2.16.840.1.113883.6.96" displayName="Moderate"/>
      </observation></entryRelationship>
    </observation></entryRelationship>
  </act></entry>
</section>`;

const NO_KNOWN_ALLERGY = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.6"/>
  <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Allergies</title>
  <text><content ID="nof">No known active allergies</content></text>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN" negationInd="true">
      <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
      <value xsi:type="CD" code="419199007" codeSystem="2.16.840.1.113883.6.96" displayName="Allergy to substance"/>
      <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
        <code nullFlavor="NA"/>
      </playingEntity></participantRole></participant>
    </observation></entryRelationship>
  </act></entry>
</section>`;

const PROBLEM = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Active Problems</title>
  <text><table><tbody><tr ID="p1name"><td>Asthma</td></tr></tbody></table></text>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20190601"/></effectiveTime>
      <value xsi:type="CD" code="195967001" codeSystem="2.16.840.1.113883.6.96" displayName="Asthma">
        <translation code="J45.909" codeSystem="2.16.840.1.113883.6.90" displayName="Unspecified asthma"/>
      </value>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.6"/>
        <value xsi:type="CD" code="55561003" displayName="Active"/>
      </observation></entryRelationship>
    </observation></entryRelationship>
  </act></entry>
</section>`;

describe("CCD allergy extraction", () => {
  it("extracts a documented allergy with reaction + severity", () => {
    const r = extractFromCcda(doc(REAL_ALLERGY));
    expect(r.allergies).toHaveLength(1);
    const a = r.allergies![0];
    expect(a.substance).toBe("Penicillin");
    expect(a.substance_code).toBe("7980");
    expect(a.substance_code_system).toBe("RxNorm");
    expect(a.reaction).toBe("Hives");
    expect(a.severity).toBe("Moderate");
    expect(a.status).toBe("active");
    expect(a.onset_date).toBe("2018-01-01");
  });

  it("drops a 'no known allergies' statement — no junk row", () => {
    const r = extractFromCcda(doc(NO_KNOWN_ALLERGY));
    expect(r.allergies).toEqual([]);
  });
});

describe("CCD problem-list extraction", () => {
  it("extracts a condition with ICD-10 code, status, onset", () => {
    const r = extractFromCcda(doc(PROBLEM));
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Asthma");
    expect(c.code).toBe("J45.909");
    expect(c.code_system).toBe("ICD-10-CM");
    expect(c.status).toBe("active");
    expect(c.onset_date).toBe("2019-06-01");
  });
});
