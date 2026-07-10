// DB INTEGRATION TIER — CCD Progress Notes / per-clinician Notes / standalone Visit
// Diagnoses (issue #219). Drives the REAL persist path end to end:
//   extractFromCcda → healthRecordToPersistInput → persistDocumentImport
// and asserts the routed rows actually land in the encounters/conditions footprint
// tables — the note text on encounters.notes, standalone visit diagnoses folded into
// encounters.diagnoses (correlated) or the conditions table (uncorrelatable), and an
// uncorrelatable note as a note-only encounter — plus that the import tally counts
// them. The pure tier (lib/__tests__/cda-notes-diagnoses.test.ts) proves the routing;
// this proves it survives the writer + count.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', 'ccd')`
      )
      .run(profileId, filename).lastInsertRowid
  );
}

function importXml(profileId: number, docId: number, xml: string) {
  const parsed = extractFromCcda(xml);
  const input = healthRecordToPersistInput(parsed, "ccd-test", "CCD");
  return persistDocumentImport(profileId, docId, input);
}

function doc(...sections: string[]): string {
  return `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260608"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
    <administrativeGenderCode code="M"/>
    <birthTime value="20200101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${sections.map((s) => `<component>${s}</component>`).join("")}
  </structuredBody></component>
</ClinicalDocument>`;
}

const ENCOUNTER = `
<section>
  <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Encounters</title>
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3" extension="ENC-1"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="20260608"/></effectiveTime>
  </encounter></entry>
</section>`;

const VISIT_DX = `
<section>
  <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
  <title>Visit Diagnoses</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
    <code code="363746003" codeSystem="2.16.840.1.113883.6.96"/>
    <value xsi:type="CD" code="363746003" codeSystem="2.16.840.1.113883.6.96" displayName="Acute pharyngitis">
      <translation code="J02.9" codeSystem="2.16.840.1.113883.6.90" displayName="Acute pharyngitis, unspecified"/>
    </value>
  </observation></entry>
</section>`;

const PROGRESS_NOTES = `
<section>
  <code code="11506-3" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Progress Notes</title>
  <text>Patient improving; continue supportive care.</text>
</section>`;

const CLINICIAN_NOTES = `
<section>
  <code code="11488-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Notes from Dr. Ada Lovelace</title>
  <author>
    <time value="20260608"/>
    <assignedAuthor>
      <assignedPerson><name><given>Ada</given><family>Lovelace</family></name></assignedPerson>
    </assignedAuthor>
  </author>
  <text>Recommend follow-up in one week.</text>
</section>`;

describe("CCD notes + visit diagnoses persist (#219)", () => {
  let single: number;
  let noEnc: number;

  beforeAll(() => {
    single = newProfile("Single Encounter");
    noEnc = newProfile("No Encounter");
  });

  it("correlates visit diagnoses + attaches notes onto the single encounter", () => {
    const docId = newDocument(single, "visit.xml");
    const outcome = importXml(
      single,
      docId,
      doc(ENCOUNTER, VISIT_DX, PROGRESS_NOTES, CLINICIAN_NOTES)
    );

    const encs = db
      .prepare(
        "SELECT type, diagnoses, notes FROM encounters WHERE profile_id = ? AND document_id = ?"
      )
      .all(single, docId) as {
      type: string;
      diagnoses: string;
      notes: string;
    }[];
    expect(encs).toHaveLength(1);
    expect(encs[0].type).toBe("Office Visit");
    expect(encs[0].diagnoses).toBe("Acute pharyngitis");
    expect(encs[0].notes).toBe(
      "Patient improving; continue supportive care.\n" +
        "Ada Lovelace: Recommend follow-up in one week."
    );

    // Correlated — not spilled into the problem list.
    const conds = db
      .prepare(
        "SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ? AND document_id = ?"
      )
      .get(single, docId) as { n: number };
    expect(conds.n).toBe(0);

    // The tally counts the one encounter row.
    expect(outcome.extractedCount).toBe(1);
  });

  it("lands an uncorrelatable visit diagnosis as a condition and a note as a note-only encounter", () => {
    const docId = newDocument(noEnc, "notes-only.xml");
    const outcome = importXml(noEnc, docId, doc(VISIT_DX, PROGRESS_NOTES));

    const cond = db
      .prepare(
        "SELECT name, code, code_system, external_id FROM conditions WHERE profile_id = ? AND document_id = ?"
      )
      .get(noEnc, docId) as {
      name: string;
      code: string;
      code_system: string;
      external_id: string;
    };
    expect(cond.name).toBe("Acute pharyngitis");
    expect(cond.code).toBe("J02.9");
    expect(cond.code_system).toBe("ICD-10-CM");
    // Source-prefixed by the writer; the visit-dx provenance namespace survives.
    expect(cond.external_id.includes("ccda:visit-dx:")).toBe(true);

    const enc = db
      .prepare(
        "SELECT type, date, notes, diagnoses FROM encounters WHERE profile_id = ? AND document_id = ?"
      )
      .get(noEnc, docId) as {
      type: string;
      date: string;
      notes: string;
      diagnoses: string | null;
    };
    expect(enc.type).toBe("Progress Notes");
    expect(enc.date).toBe("2026-06-08");
    expect(enc.notes).toBe("Patient improving; continue supportive care.");
    expect(enc.diagnoses).toBeNull();

    // One condition + one note-only encounter = 2 rows counted.
    expect(outcome.extractedCount).toBe(2);
  });
});
