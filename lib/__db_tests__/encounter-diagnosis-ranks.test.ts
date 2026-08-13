// DB INTEGRATION TIER — the structured visit-diagnosis rank (#2589 half 1),
// through the REAL import path: parseFhirBundle → healthRecordToPersistInput →
// persistDocumentImport, then read back through the query layer the visit
// surfaces use.
//
// What is being pinned is a DIVISION, not a feature: a rank exists on a row when
// and only when the SOURCE stated one structurally. FHIR R4 does
// (Encounter.diagnosis.rank / .use); C-CDA R2.1's Encounter Diagnosis act defines
// no rank element, which is exactly why the document in #2589 arrived with
// " - Primary" welded into a display name. So the CDA half of this file asserts
// an ABSENCE — and asserts that the welded name is stored byte-for-byte, because
// reading a rank out of it is the inference two withdrawn attempts were refuted
// for.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. SYNTHETIC
// ONLY: invented patient, fictional dates. No PHI.

import { describe, it, expect, beforeAll } from "vitest";
import { parseFhirBundle } from "@/lib/fhir";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { getEncounter, getEncounters } from "@/lib/queries";
import { decodeDiagnosisRanks } from "@/lib/visit-diagnosis-rank";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDocument(profileId: number, filename: string, kind: string) {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, ?, '', 'processing', ?)`
      )
      .run(profileId, filename, kind).lastInsertRowid
  );
}

// One visit with two diagnoses: the source states which is primary, and states a
// discharge role on it.
const BUNDLE = JSON.stringify({
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      fullUrl: "urn:uuid:cond-1",
      resource: {
        resourceType: "Condition",
        id: "cond-1",
        code: { text: "Acute bronchitis" },
      },
    },
    {
      fullUrl: "urn:uuid:cond-2",
      resource: {
        resourceType: "Condition",
        id: "cond-2",
        code: { text: "Essential hypertension" },
      },
    },
    {
      fullUrl: "urn:uuid:enc-1",
      resource: {
        resourceType: "Encounter",
        id: "enc-1",
        status: "finished",
        type: [{ text: "Office Visit" }],
        period: { start: "2026-05-04" },
        diagnosis: [
          {
            condition: { reference: "urn:uuid:cond-1" },
            rank: 1,
            use: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/diagnosis-role",
                  code: "DD",
                },
              ],
            },
          },
          { condition: { reference: "urn:uuid:cond-2" }, rank: 2 },
        ],
      },
    },
  ],
});

// The #2589 shape, in a CCD: one diagnosis listed twice, the second with the rank
// welded into its display name by the source system.
const CCD = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <effectiveTime value="20260504"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
    <administrativeGenderCode code="M"/>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody><component>
    <section>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3" extension="ENC-RANK"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
        <effectiveTime><low value="20260504"/></effectiveTime>
        <entryRelationship typeCode="SUBJ">
          <observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
            <value xsi:type="CD" code="Z31.430" codeSystem="2.16.840.1.113883.6.90"
                   displayName="Encounter of male for testing for genetic disease carrier status for procreative management"/>
          </observation>
        </entryRelationship>
        <entryRelationship typeCode="SUBJ">
          <observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
            <value xsi:type="CD" code="Z31.430" codeSystem="2.16.840.1.113883.6.90"
                   displayName="Encounter of male for testing for genetic disease carrier status for procreative management - Primary"/>
          </observation>
        </entryRelationship>
      </encounter></entry>
    </section>
  </component></structuredBody></component>
</ClinicalDocument>`;

const Z_CODE =
  "Encounter of male for testing for genetic disease carrier status for procreative management";

describe("encounters.diagnosis_ranks (#2589)", () => {
  let fhirProfile = 0;
  let cdaProfile = 0;

  beforeAll(() => {
    fhirProfile = newProfile("Rank FHIR");
    persistDocumentImport(
      fhirProfile,
      newDocument(fhirProfile, "visit.json", "fhir"),
      healthRecordToPersistInput(parseFhirBundle(BUNDLE), "fhir", "FHIR export")
    );
    cdaProfile = newProfile("Rank CDA");
    persistDocumentImport(
      cdaProfile,
      newDocument(cdaProfile, "visit.xml", "ccd"),
      healthRecordToPersistInput(extractFromCcda(CCD), "ccd-test", "CCD")
    );
  });

  it("stores what a FHIR source stated, beside the summary and not inside it", () => {
    const enc = getEncounters(fhirProfile)[0];
    // The joined summary is untouched by any of this.
    expect(enc.diagnoses).toBe("Acute bronchitis; Essential hypertension");
    expect(decodeDiagnosisRanks(enc.diagnosis_ranks)).toEqual([
      { name: "Acute bronchitis", rank: 1, use: ["dd"] },
      { name: "Essential hypertension", rank: 2 },
    ]);
    // Both readers the visit surfaces use carry the column.
    expect(getEncounter(fhirProfile, enc.id)!.diagnosis_ranks).toBe(
      enc.diagnosis_ranks
    );
  });

  it("leaves a CDA-sourced visit with no rank at all, and its names verbatim", () => {
    const enc = getEncounters(cdaProfile)[0];
    // C-CDA R2.1 has no rank element to read, so the column stays NULL — an
    // absence, never a rank guessed from the " - Primary" the source welded into
    // the second display name.
    expect(enc.diagnosis_ranks).toBeNull();
    expect(enc.diagnoses).toBe(`${Z_CODE}; ${Z_CODE} - Primary`);
  });

  it("is idempotent across a re-import of the same document", () => {
    const before = getEncounters(fhirProfile);
    const docId = newDocument(fhirProfile, "visit.json", "fhir");
    persistDocumentImport(
      fhirProfile,
      docId,
      healthRecordToPersistInput(parseFhirBundle(BUNDLE), "fhir", "FHIR export")
    );
    const after = getEncounters(fhirProfile);
    expect(after.map((e) => e.diagnosis_ranks)).toEqual(
      before.map((e) => e.diagnosis_ranks)
    );
  });
});
