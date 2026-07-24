// DB INTEGRATION TIER — CCD narrative report → `report` medical_records row (#708).
//
// A microbiology culture / gram stain / cytopathology report ships as a Results-section
// Observation whose <value xsi:type="ED"> references the report body in the narrative
// <table>. This drives the REAL persist path end to end (extractFromCcda →
// healthRecordToPersistInput → persistDocumentImport) and asserts the report lands as a
// `report` record with its body in `notes` (value NULL), reachable via getReportRecords,
// while an ordinary numeric lab in the same section stays a `lab` reading. All fixtures
// SYNTHETIC — obviously-fictional report text, no real PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { getReportRecords } from "@/lib/queries";

let profileId: number;
let docId: number;

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
      <text>
        <content ID="CultureBody">Many Escherichia coli greater than 100,000 CFU/mL. No anaerobes isolated.</content>
        <content ID="GramBody">Few gram-positive cocci in clusters. Moderate white blood cells seen.</content>
      </text>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="1.2.3" extension="RPT-1"/>
        <code code="34574-4" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"><originalText>Final Report</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime value="20240301"/>
        <value xsi:type="ED"><reference value="#CultureBody"/></value>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.2"/>
        <id root="1.2.3" extension="RPT-2"/>
        <code code="11502-2" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC"><originalText>Gram Stain Report</originalText></code>
        <statusCode code="completed"/>
        <effectiveTime value="20240301"/>
        <value xsi:type="ED"><reference value="#GramBody"/></value>
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
    db.prepare("INSERT INTO profiles (name) VALUES ('CDA Reports')").run()
      .lastInsertRowid
  );
  docId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'micro.ccd', '', 'processing', 'ccd')`
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

describe("CCD narrative report → `report` medical_records row", () => {
  it("persists each ED-valued report as a `report` row with the body in notes (no value)", () => {
    const rows = db
      .prepare(
        `SELECT category, name, value, value_num, notes, loinc, external_id
           FROM medical_records
          WHERE profile_id = ? AND document_id = ? AND category = 'report'
          ORDER BY name`
      )
      .all(profileId, docId) as {
      category: string;
      name: string;
      value: string | null;
      value_num: number | null;
      notes: string | null;
      loinc: string | null;
      external_id: string;
    }[];
    expect(rows).toHaveLength(2);
    const final = rows.find((r) => r.name === "Final Report")!;
    expect(final).toMatchObject({
      value: null,
      value_num: null,
      loinc: "34574-4",
    });
    expect(final.notes).toContain("Escherichia coli");
    expect(final.external_id).toMatch(/ccda:report:RPT-1$/);
    const gram = rows.find((r) => r.name === "Gram Stain Report")!;
    expect(gram.notes).toContain("gram-positive cocci");
  });

  it("keeps an ordinary numeric lab as a `lab` reading (reports don't cannibalize labs)", () => {
    const labs = db
      .prepare(
        `SELECT name, value_num FROM medical_records
          WHERE profile_id = ? AND document_id = ? AND category = 'lab'`
      )
      .all(profileId, docId) as { name: string; value_num: number | null }[];
    expect(labs).toEqual([{ name: "Hemoglobin", value_num: 14.1 }]);
  });

  it("surfaces the reports via getReportRecords, newest first", () => {
    const reports = getReportRecords(profileId);
    expect(reports.map((r) => r.name).sort()).toEqual([
      "Final Report",
      "Gram Stain Report",
    ]);
    for (const r of reports) {
      expect(r.notes && r.notes.length).toBeGreaterThan(0);
      expect(r.document_id).toBe(docId);
    }
  });

  it("does not list the report LOINCs as unmapped analytes on the import report", () => {
    const doc = db
      .prepare(`SELECT import_report FROM medical_documents WHERE id = ?`)
      .get(docId) as { import_report: string | null };
    const report = doc.import_report ?? "";
    // 34574-4 / 11502-2 are report codes, never "add to LOINC_TO_CANONICAL" hints.
    expect(report).not.toContain("34574-4");
    expect(report).not.toContain("11502-2");
  });
});
