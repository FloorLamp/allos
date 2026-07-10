import { describe, expect, it } from "vitest";
import { extractFromCcda } from "../cda";

// Wrap a Social History section (and optional patient header attrs) in a minimal
// ClinicalDocument so extractFromCcda can walk it.
function doc(section: string, opts: { gender?: string } = {}): string {
  const gender = opts.gender
    ? `<administrativeGenderCode code="${opts.gender}" codeSystem="2.16.840.1.113883.5.1"/>`
    : "";
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
    ${gender}
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component>${section}</component>
  </structuredBody></component>
</ClinicalDocument>`;
}

// A Social History section modelled on the real Epic export: a smoking-status
// observation (72166-2), a Sex-assigned-at-birth observation (76689-9), and a Sex
// observation (46098-0). `smoking` / `birthSex` / `legalSex` are the inner <value>
// XML so each test can vary them.
function socialSection(vals: {
  smoking?: string;
  birthSex?: string;
  legalSex?: string;
}): string {
  const smoking = vals.smoking
    ? `<entry><observation classCode="OBS" moodCode="EVN">
         <templateId root="2.16.840.1.113883.10.20.22.4.78"/>
         <code code="72166-2" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Tobacco smoking status NHIS"/>
         <statusCode code="completed"/>
         <effectiveTime value="20240708"/>
         ${vals.smoking}
       </observation></entry>`
    : "";
  const birthSex = vals.birthSex
    ? `<entry><observation classCode="OBS" moodCode="EVN">
         <templateId root="2.16.840.1.113883.10.20.22.4.200"/>
         <code code="76689-9" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Sex assigned at birth"/>
         <statusCode code="completed"/>
         ${vals.birthSex}
       </observation></entry>`
    : "";
  const legalSex = vals.legalSex
    ? `<entry><observation classCode="OBS" moodCode="EVN">
         <templateId root="2.16.840.1.113883.10.20.22.4.38"/>
         <code code="46098-0" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Sex"/>
         <statusCode code="completed"/>
         ${vals.legalSex}
       </observation></entry>`
    : "";
  return `<section>
    <templateId root="2.16.840.1.113883.10.20.22.2.17"/>
    <code code="29762-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Social History</title>
    ${smoking}${birthSex}${legalSex}
  </section>`;
}

const FORMER_SMOKER = `<value xsi:type="CD" code="8517006" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMED CT" displayName="Former smoker"/>`;
const SMOKING_UNKNOWN = `<value xsi:type="CD" code="266927001" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMED CT" displayName="Tobacco smoking consumption unknown"/>`;
const MALE_FINDING = `<value xsi:type="CD" code="248153007" codeSystem="2.16.840.1.113883.6.96" codeSystemName="SNOMEDCT" displayName="Male (finding)"/>`;
const BIRTHSEX_UNK = `<value xsi:type="CD" codeSystem="2.16.840.1.113883.5.1" codeSystemName="HL7 Gender" nullFlavor="UNK"/>`;
const BIRTHSEX_FEMALE = `<value xsi:type="CD" code="F" codeSystem="2.16.840.1.113883.5.1"/>`;

describe("CCD Social History extraction", () => {
  it("captures the smoking status as a social-history condition", () => {
    const r = extractFromCcda(doc(socialSection({ smoking: FORMER_SMOKER })));
    expect(r.conditions).toHaveLength(1);
    const c = r.conditions![0];
    expect(c.name).toBe("Former smoker");
    expect(c.code).toBe("8517006");
    expect(c.code_system).toBe("SNOMED CT");
    expect(c.status).toBe("active");
    expect(c.external_id).toBe("ccda:social-smoking:8517006");
  });

  it("drops a 'consumption unknown' smoking status — no junk condition", () => {
    const r = extractFromCcda(doc(socialSection({ smoking: SMOKING_UNKNOWN })));
    expect(r.conditions).toEqual([]);
  });

  it("seeds demographics.sex from the section when the header states none", () => {
    // No header administrativeGenderCode; the section Sex (46098-0) supplies it.
    const r = extractFromCcda(doc(socialSection({ legalSex: MALE_FINDING })));
    expect(r.demographics?.sex).toBe("male");
  });

  it("prefers sex-assigned-at-birth over the administrative Sex", () => {
    const r = extractFromCcda(
      doc(socialSection({ birthSex: BIRTHSEX_FEMALE, legalSex: MALE_FINDING }))
    );
    expect(r.demographics?.sex).toBe("female");
  });

  it("falls back to the administrative Sex when birth-sex is UNK", () => {
    // Mirrors the real Epic record: 76689-9 nullFlavor UNK, 46098-0 = Male.
    const r = extractFromCcda(
      doc(socialSection({ birthSex: BIRTHSEX_UNK, legalSex: MALE_FINDING }))
    );
    expect(r.demographics?.sex).toBe("male");
  });

  it("never overrides a sex already stated in the header", () => {
    const r = extractFromCcda(
      doc(socialSection({ legalSex: MALE_FINDING }), { gender: "F" })
    );
    // Header says female; the section's male must not override it.
    expect(r.demographics?.sex).toBe("female");
  });
});
