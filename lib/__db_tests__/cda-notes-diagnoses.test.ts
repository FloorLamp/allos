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

// A standalone "Fever" visit diagnosis (self-limited, episodic). Uncorrelatable
// when the document carries no single encounter → lands as a condition (#590).
const FEVER_VISIT_DX = `
<section>
  <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
  <title>Visit Diagnoses</title>
  <entry><observation classCode="OBS" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
    <code code="386661006" codeSystem="2.16.840.1.113883.6.96"/>
    <value xsi:type="CD" code="386661006" codeSystem="2.16.840.1.113883.6.96" displayName="Fever">
      <translation code="R50.9" codeSystem="2.16.840.1.113883.6.90" displayName="Fever, unspecified"/>
    </value>
  </observation></entry>
</section>`;

// A birth-EVENT problem-list entry (ICD-10 Z38.0) with only the concern act's
// tracking status "active" — no explicit clinical-status observation (#590).
const BIRTH_EVENT_PROBLEM = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Active Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <value xsi:type="CD" code="442311008" codeSystem="2.16.840.1.113883.6.96" displayName="Single liveborn, born in hospital">
        <translation code="Z38.0" codeSystem="2.16.840.1.113883.6.90" displayName="Single liveborn infant, delivered vaginally"/>
      </value>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A chronic-capable problem (Asthma) with only the tracking status "active" and no
// explicit clinical-status observation — must stay active (#590 non-regression).
const ASTHMA_NO_STATUS = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Active Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <value xsi:type="CD" code="195967001" codeSystem="2.16.840.1.113883.6.96" displayName="Asthma">
        <translation code="J45.909" codeSystem="2.16.840.1.113883.6.90" displayName="Unspecified asthma"/>
      </value>
    </observation></entryRelationship>
  </act></entry>
</section>`;

// A self-limited name (Influenza) carrying an EXPLICIT clinical-status observation
// "active" (template 4.6) with an OLD onset — explicit status is authoritative, so
// it stays active despite being on the self-limited list (#590).
const INFLUENZA_EXPLICIT_ACTIVE = `
<section>
  <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
  <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
  <title>Active Problems</title>
  <entry><act classCode="ACT" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
    <statusCode code="active"/>
    <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <effectiveTime><low value="20200101"/></effectiveTime>
      <value xsi:type="CD" code="6142004" codeSystem="2.16.840.1.113883.6.96" displayName="Influenza">
        <translation code="J11.1" codeSystem="2.16.840.1.113883.6.90" displayName="Influenza with other respiratory manifestations"/>
      </value>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.6"/>
        <value xsi:type="CD" code="55561003" displayName="Active"/>
      </observation></entryRelationship>
    </observation></entryRelationship>
  </act></entry>
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

// #590 — CCD-imported conditions: status/date fallbacks used to make everything
// permanently "active". The import now only ever DOWNGRADES active → resolved
// (never invents active), for birth events and stale/episodic self-limited rows,
// while an explicit clinical-status observation stays authoritative.
describe("CCD condition status/date intelligence (#590)", () => {
  function landCondition(name: string, section: string) {
    const pid = newProfile(name);
    const docId = newDocument(pid, `${name}.xml`);
    importXml(pid, docId, doc(section));
    return db
      .prepare(
        `SELECT name, code, status, onset_date, resolved_date
           FROM conditions WHERE profile_id = ? AND document_id = ?`
      )
      .get(pid, docId) as {
      name: string;
      code: string | null;
      status: string;
      onset_date: string | null;
      resolved_date: string | null;
    };
  }

  it("(1) an uncorrelatable Fever visit dx from a dated document → resolved, onset = visit date", () => {
    const c = landCondition("fever-visit", FEVER_VISIT_DX);
    expect(c.name).toBe("Fever");
    expect(c.status).toBe("resolved");
    // Onset falls back to the document effectiveTime (the visit date), not fabricated
    // for a problem-list row but correct for a visit diagnosis.
    expect(c.onset_date).toBe("2026-06-08");
    expect(c.resolved_date).toBeNull();
  });

  it("(2) a Z38.0 birth-event problem (tracking-active, no clinical status) → resolved", () => {
    const c = landCondition("birth-event", BIRTH_EVENT_PROBLEM);
    expect(c.name).toBe("Single liveborn, born in hospital");
    expect(c.code).toBe("Z38.0");
    expect(c.status).toBe("resolved");
  });

  it("(3) an active Asthma problem with no clinical-status observation → still active", () => {
    const c = landCondition("asthma-active", ASTHMA_NO_STATUS);
    expect(c.name).toBe("Asthma");
    expect(c.status).toBe("active");
  });

  it("(4) an explicit clinical-status 'active' on a listed name → stays active", () => {
    const c = landCondition("influenza-explicit", INFLUENZA_EXPLICIT_ACTIVE);
    expect(c.name).toBe("Influenza");
    expect(c.status).toBe("active");
    expect(c.onset_date).toBe("2020-01-01");
  });
});
