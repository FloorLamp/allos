// DB INTEGRATION TIER — the ingest boundary for time, end to end (#2243, #2205 phase 0).
//
// These drive the REAL deterministic ingest path (ingestMedicalUpload → the C-CDA
// parser → import-persist) with synthetic CCDs and pin the three things phase 0 claims:
//
//   1. An offset-bearing <effectiveTime> lands the correct UTC instant in the
//      instant-grained destination (medical_records.occurred_at) AND the day the
//      document stated in the day-grained one (medical_records.date) — including when
//      those two disagree, which is the #94 day-attribution rule decision 2 protects.
//   2. A ZONELESS <effectiveTime> leaves the instant NULL and the day intact. The
//      profile's timezone is never consulted to invent a moment (decision 3).
//   3. A document imported BEFORE this change — day-only rows, source file retained —
//      recovers its discarded instants through the ordinary reprocess affordance
//      (decision 4: repair is by reprocess, not by migration; the information was never
//      in the database to move).
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past-or-fictional dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  ingestMedicalUpload,
  reprocessDocumentById,
} from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { parseFhirBundle } from "@/lib/fhir";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";

// One Results section with three observations, differing ONLY in what their
// effectiveTime states about when.
//
//   2093-3  an offset-bearing time whose UTC day is the SAME as its stated day.
//   2085-9  an offset-bearing time whose UTC day is the PREVIOUS one — the pin.
//   2571-8  a zoneless clock: a time with no zone anybody supplied.
function ccda(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="90210001"/>
  <effectiveTime value="20260807143000-0500"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><organizer classCode="BATTERY" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"/>
          <effectiveTime value="20260807143000-0500"/>
          <value type="PQ" value="188" unit="mg/dL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2085-9" codeSystem="2.16.840.1.113883.6.1" displayName="HDL Cholesterol"/>
          <effectiveTime value="20260101003000+0900"/>
          <value type="PQ" value="61" unit="mg/dL"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="2571-8" codeSystem="2.16.840.1.113883.6.1" displayName="Triglycerides"/>
          <effectiveTime value="20260807143000"/>
          <value type="PQ" value="120" unit="mg/dL"/>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

function upload(xml: string, name: string): File {
  return new File([Buffer.from(xml)], name, { type: "application/xml" });
}

interface Row {
  loinc: string | null;
  date: string;
  occurred_at: string | null;
}

function readings(profileId: number): Record<string, Row> {
  const rows = db
    .prepare(
      `SELECT loinc, date, occurred_at FROM medical_records
         WHERE profile_id = ? AND loinc IS NOT NULL ORDER BY loinc`
    )
    .all(profileId) as Row[];
  return Object.fromEntries(rows.map((r) => [r.loinc as string, r]));
}

describe("a C-CDA's stated time survives to its destination (#2243)", () => {
  it("fills the instant destination from an offset, and the day from the document's own digits", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(ccda(), "lipids.xml")
    );

    const byLoinc = readings(profile.id);

    // An offset-bearing time whose stated day and UTC day agree.
    expect(byLoinc["2093-3"].date).toBe("2026-08-07");
    expect(byLoinc["2093-3"].occurred_at).toBe("2026-08-07T19:30:00Z");

    // THE PIN. `20260101003000+0900` states 2026-01-01 and IS 2025-12-31T15:30:00Z.
    // The day-grained column takes the day the DOCUMENT stated; the instant-grained
    // one takes the absolute moment. They disagree, and both are right — deriving
    // either from the other would be wrong in one of the two columns.
    expect(byLoinc["2085-9"].date).toBe("2026-01-01");
    expect(byLoinc["2085-9"].occurred_at).toBe("2025-12-31T15:30:00Z");
    expect(byLoinc["2085-9"].occurred_at!.slice(0, 10)).not.toBe(
      byLoinc["2085-9"].date
    );
  });

  it("leaves the instant NULL for a zoneless clock, and keeps the day", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(ccda(), "lipids.xml")
    );

    const byLoinc = readings(profile.id);
    // The document said 14:30 and never said where. Resolving that against the
    // profile's timezone would invent a moment the document did not state, so the
    // column stays NULL — and the day, which WAS stated, is untouched.
    expect(byLoinc["2571-8"].date).toBe("2026-08-07");
    expect(byLoinc["2571-8"].occurred_at).toBeNull();
  });

  it("writes the instant in the canonical stored shape", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(ccda(), "lipids.xml")
    );
    for (const loinc of ["2093-3", "2085-9"]) {
      // UTC, second resolution, explicit Z — lib/date.ts's utcInstant, the convention
      // medical_records.occurred_at was born on (migration 165).
      expect(readings(profile.id)[loinc].occurred_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
      );
    }
  });
});

describe("repair is by reprocess, not by migration (#2243 decision 4)", () => {
  it("recovers the instants a pre-change import discarded, from the file the app still holds", async () => {
    const { login, profile } = seedActor();
    const outcome = await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(ccda(), "lipids.xml")
    );
    expect(outcome.refusal).toBeNull();
    expect(outcome.docId).not.toBeNull();

    const doc = db
      .prepare(
        `SELECT id, stored_path FROM medical_documents WHERE id = ? AND profile_id = ?`
      )
      .get(outcome.docId, profile.id) as {
      id: number;
      stored_path: string | null;
    };

    // Model the state a PRE-CHANGE import left behind: the day survived, the stated
    // clock and offset did not, and the source document is still on disk. That last
    // part is the whole argument for reprocess — a migration could not do this work
    // because the discarded times were never in the database to move.
    db.prepare(
      `UPDATE medical_records SET occurred_at = NULL WHERE profile_id = ?`
    ).run(profile.id);
    const before = readings(profile.id);
    expect(before["2093-3"].occurred_at).toBeNull();
    expect(before["2085-9"].occurred_at).toBeNull();
    expect(before["2093-3"].date).toBe("2026-08-07");
    expect(doc.stored_path).toBeTruthy();

    // The ordinary affordance — no new repair path, no flag.
    reprocessDocumentById(login.id, profile.id, doc.id);

    const after = readings(profile.id);
    expect(after["2093-3"].occurred_at).toBe("2026-08-07T19:30:00Z");
    expect(after["2085-9"].occurred_at).toBe("2025-12-31T15:30:00Z");
    // The zoneless one has nothing to recover and correctly stays NULL.
    expect(after["2571-8"].occurred_at).toBeNull();
    // Day attribution is unchanged by the repair — reprocess fills what was missing,
    // it does not re-attribute what was already right.
    expect(after["2093-3"].date).toBe(before["2093-3"].date);
    expect(after["2085-9"].date).toBe("2026-01-01");
  });
});

// The FHIR half of the same boundary. `Observation.effectiveDateTime` is a FHIR
// `dateTime`, which MAY carry an offset and may equally carry none — so it exercises
// the same three arms as the C-CDA path, through the production shape converter +
// persister rather than the upload sniffer.
describe("a FHIR bundle's stated time survives to its destination (#2243)", () => {
  const BUNDLE = JSON.stringify({
    resourceType: "Bundle",
    type: "collection",
    entry: [
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Glucose",
            coding: [{ system: "http://loinc.org", code: "2345-7" }],
          },
          valueQuantity: { value: 95, unit: "mg/dL" },
          effectiveDateTime: "2026-01-01T00:30:00+09:00",
        },
      },
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          code: {
            text: "Sodium",
            coding: [{ system: "http://loinc.org", code: "2951-2" }],
          },
          valueQuantity: { value: 140, unit: "mmol/L" },
          effectiveDateTime: "2026-08-07T14:30:00",
        },
      },
    ],
  });

  it("keeps the stated day and the absolute moment apart, and refuses to invent one", () => {
    const { profile } = seedActor();
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, extraction_status, doc_type)
           VALUES (?, 'labs.json', '', 'processing', 'fhir')`
        )
        .run(profile.id).lastInsertRowid
    );
    persistDocumentImport(
      profile.id,
      docId,
      healthRecordToPersistInput(parseFhirBundle(BUNDLE), "fhir", "FHIR export")
    );

    const byLoinc = readings(profile.id);
    // Offset-bearing, and its UTC day is the previous one — the same pin as the CCD.
    expect(byLoinc["2345-7"].date).toBe("2026-01-01");
    expect(byLoinc["2345-7"].occurred_at).toBe("2025-12-31T15:30:00Z");
    // A FHIR dateTime is allowed to omit its offset, and when it does there is no
    // moment to store.
    expect(byLoinc["2951-2"].date).toBe("2026-08-07");
    expect(byLoinc["2951-2"].occurred_at).toBeNull();
  });
});
