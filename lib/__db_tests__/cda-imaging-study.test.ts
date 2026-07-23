// DB INTEGRATION TIER — CCD radiology-study → imaging_studies (#708 CDA feed).
//
// Epic ships a radiology study as a Result Observation coded LOINC 18782-3 with a
// nullFlavor value but structured methodCode (modality), targetSiteCode (body region
// + laterality) and an effectiveTime — previously dropped as a null-value lab. This
// drives the REAL persist path end to end (extractFromCcda → healthRecordToPersistInput
// → persistDocumentImport) and asserts the study lands in imaging_studies, reusing the
// same shared modality/laterality normalizers the FHIR ImagingStudy path uses. All
// fixtures SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";

let profileId: number;
let docId: number;

// A Results section carrying (a) a radiology-study observation and (b) an ordinary
// numeric lab, so we prove the study routes to imaging_studies while the lab stays a
// record.
const CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20240301"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="1.2.3" extension="IMG-77"/>
        <code code="18782-3" codeSystem="2.16.840.1.113883.6.1"><originalText>Radiology Study observation (narrative)</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime><low value="20240301120000-0500"/></effectiveTime>
        <value xsi:type="ST" nullFlavor="NA"/>
        <methodCode code="4" codeSystem="1.2.840.114350.1.13.535.2.7.10.x"><originalText>Ultrasound</originalText></methodCode>
        <targetSiteCode code="119" codeSystem="1.2.840.114350.1.13.535.2.7.10.y"><originalText>Breast</originalText>
          <qualifier><name code="272741003" codeSystem="2.16.840.1.113883.6.96"/>
            <value code="7771000" codeSystem="2.16.840.1.113883.6.96" xsi:type="CD" displayName="left"><originalText>left</originalText></value>
          </qualifier>
        </targetSiteCode>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="718-7" codeSystem="2.16.840.1.113883.6.1" displayName="Hemoglobin"/>
        <effectiveTime value="20240301"/>
        <value xsi:type="PQ" value="14.1" unit="g/dL"/>
      </observation></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CDA Imaging')").run()
      .lastInsertRowid
  );
  docId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'rad.ccd', '', 'processing', 'ccd')`
      )
      .run(profileId).lastInsertRowid
  );
  const parsed = extractFromCcda(CCD);
  persistDocumentImport(
    profileId,
    docId,
    healthRecordToPersistInput(parsed, "ccd-test", "CCD")
  );
});

describe("CCD radiology-study → imaging_studies", () => {
  it("persists the radiology observation as an imaging study (modality/site/laterality)", () => {
    const rows = db
      .prepare(
        `SELECT modality, body_region, laterality, study_date, external_id
           FROM imaging_studies WHERE profile_id = ? AND document_id = ?`
      )
      .all(profileId, docId) as {
      modality: string;
      body_region: string | null;
      laterality: string | null;
      study_date: string | null;
      external_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      modality: "ultrasound",
      body_region: "Breast",
      laterality: "left",
      study_date: "2024-03-01",
    });
    // The persist layer scopes the external_id with the document source; the stable
    // content key is the CDA imaging suffix.
    expect(rows[0].external_id).toMatch(/ccda:imaging:IMG-77$/);
  });

  it("does NOT route the radiology observation into medical_records, and keeps the real lab", () => {
    const labs = db
      .prepare(
        `SELECT name FROM medical_records WHERE profile_id = ? AND document_id = ?`
      )
      .all(profileId, docId) as { name: string }[];
    const names = labs.map((l) => l.name);
    expect(names).toContain("Hemoglobin");
    expect(names.some((n) => /radiology/i.test(n))).toBe(false);
  });
});
