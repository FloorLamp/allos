// DB INTEGRATION TIER — CCD lab reference range + interpretation flag (#761 follow-up).
//
// A CCD lab observation states its own normal range (<referenceRange>) and an H/L/N/A
// interpretation (<interpretationCode>). This drives the REAL persist path — which runs
// reconcileFlags afterward — and asserts the load-bearing interaction: an UNMAPPED lab
// (no canonical band) KEEPS its source flag through reconcile (reconciledFlag returns
// "no change" with no band), while both labs store their source range. All fixtures
// SYNTHETIC.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";

let profileId: number;
let docId: number;

// One UNMAPPED lab (fictional LOINC → no canonical band) flagged High, plus a normal
// lab — both carrying a source reference range.
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
        <code code="99999-9" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Esoteric Marker XYZ"/>
        <effectiveTime value="20240301"/>
        <value xsi:type="PQ" value="88.0" unit="U/mL"/>
        <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
        <referenceRange><observationRange>
          <value xsi:type="IVL_PQ"><low value="10.0" unit="U/mL"/><high value="40.0" unit="U/mL"/></value>
          <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
        </observationRange></referenceRange>
      </observation></entry>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="99998-1" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Esoteric Marker ABC"/>
        <effectiveTime value="20240301"/>
        <value xsi:type="PQ" value="15.0" unit="U/mL"/>
        <interpretationCode code="N" codeSystem="2.16.840.1.113883.5.83"/>
        <referenceRange><observationRange>
          <value xsi:type="IVL_PQ"><low value="10.0" unit="U/mL"/><high value="40.0" unit="U/mL"/></value>
        </observationRange></referenceRange>
      </observation></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('CDA Lab Flags')").run()
      .lastInsertRowid
  );
  docId = Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'labs.ccd', '', 'processing', 'ccd')`
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

describe("CCD lab range + interpretation flag persist", () => {
  it("keeps an unmapped lab's source High flag through reconcileFlags, and stores its range", () => {
    const row = db
      .prepare(
        `SELECT flag, reference_range FROM medical_records
          WHERE profile_id = ? AND document_id = ? AND name = 'Esoteric Marker XYZ'`
      )
      .get(profileId, docId) as {
      flag: string | null;
      reference_range: string | null;
    };
    // No canonical band exists for this analyte, so reconcile can't derive a flag and
    // must LEAVE the source's "high" intact — otherwise the abnormal result vanishes.
    expect(row.flag).toBe("high");
    expect(row.reference_range).toBe("10.0–40.0 U/mL");
  });

  it("stores the source range on the normal lab too", () => {
    const row = db
      .prepare(
        `SELECT flag, reference_range FROM medical_records
          WHERE profile_id = ? AND document_id = ? AND name = 'Esoteric Marker ABC'`
      )
      .get(profileId, docId) as {
      flag: string | null;
      reference_range: string | null;
    };
    expect(row.reference_range).toBe("10.0–40.0 U/mL");
    // "normal" is a reconcilable flag; with no band it stays as the source stated.
    expect(row.flag).toBe("normal");
  });
});
