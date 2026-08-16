// DB INTEGRATION TIER — what a portal re-export WRITES into the conditions list
// (issue #2917). Drives the REAL ingest path and reads back the rows that landed.
//
// Two defects, one export shape. A MyChart "all visits" container carries many
// encounters under one document effectiveTime:
//
//   1. A standalone visit diagnosis it cannot correlate used to take the CONTAINER's
//      date as onset. That date is when the portal generated the bundle, not when
//      anything was diagnosed — and because the fallback is baked into the
//      `ccda:visit-dx:` external_id, which feeds the #1780 clinical key, two
//      collections of the identical visit list minted different identities and the
//      exact-equality duplicate refusal could never fire.
//   2. Pregnancy-state and administrative encounter Z-codes imported permanently
//      active, so one postpartum person held "Normal pregnancy in first trimester"
//      and "…third trimester" simultaneously.
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { extractFromCcda } from "@/lib/cda";
import { healthRecordToPersistInput } from "@/lib/import-shape";
import { persistDocumentImport } from "@/lib/import-persist";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { getConditions } from "@/lib/queries";

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

function conditionRows(profileId: number) {
  return db
    .prepare(
      `SELECT name, status, onset_date AS onsetDate, external_id AS externalId
         FROM conditions WHERE profile_id = ? ORDER BY name`
    )
    .all(profileId) as {
    name: string;
    status: string;
    onsetDate: string | null;
    externalId: string;
  }[];
}

// One Encounter Activity. Two of these make the document a CONTAINER.
function encounter(extension: string, day: string): string {
  return `
  <entry><encounter classCode="ENC" moodCode="EVN">
    <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
    <id root="1.2.3.4" extension="${extension}"/>
    <code code="99213" codeSystem="2.16.840.1.113883.6.12" displayName="Office Visit"/>
    <effectiveTime><low value="${day}"/></effectiveTime>
  </encounter></entry>`;
}

function encountersSection(...entries: string[]): string {
  return `
  <component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Encounters</title>
    ${entries.join("")}
  </section></component>`;
}

// A standalone Visit Diagnoses section — top-level 29308-4, no encounter correlation.
// "Essential hypertension" is chronic-capable on purpose: it must stay ACTIVE, so the
// test proves the onset change is separable from the status change.
const VISIT_DX_SECTION = `
  <component><section>
    <code code="29308-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diagnosis"/>
    <title>Visit Diagnoses</title>
    <entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
      <code code="59621000" codeSystem="2.16.840.1.113883.6.96"/>
      <value xsi:type="CD" code="59621000" codeSystem="2.16.840.1.113883.6.96" displayName="Essential hypertension">
        <translation code="I10" codeSystem="2.16.840.1.113883.6.90" displayName="Essential (primary) hypertension"/>
      </value>
    </observation></entry>
  </section></component>`;

// The pregnancy-state / administrative family the export was full of (#2917 item 1).
const PREGNANCY_ADMIN_PROBLEMS = `
  <component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.5.1"/>
    <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Active Problems</title>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <value xsi:type="CD" code="72892002" codeSystem="2.16.840.1.113883.6.96" displayName="Normal pregnancy in first trimester">
          <translation code="Z34.01" codeSystem="2.16.840.1.113883.6.90" displayName="Encounter for supervision of normal first pregnancy, first trimester"/>
        </value>
      </observation></entryRelationship>
    </act></entry>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <value xsi:type="CD" code="118185001" codeSystem="2.16.840.1.113883.6.96" displayName="Primigravida in third trimester"/>
      </observation></entryRelationship>
    </act></entry>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <value xsi:type="CD" code="169828009" codeSystem="2.16.840.1.113883.6.96" displayName="Postpartum care and examination">
          <translation code="Z39.2" codeSystem="2.16.840.1.113883.6.90" displayName="Encounter for routine postpartum follow-up"/>
        </value>
      </observation></entryRelationship>
    </act></entry>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <value xsi:type="CD" code="171234004" codeSystem="2.16.840.1.113883.6.96" displayName="Need for Tdap vaccination">
          <translation code="Z23" codeSystem="2.16.840.1.113883.6.90" displayName="Encounter for immunization"/>
        </value>
      </observation></entryRelationship>
    </act></entry>
    <entry><act classCode="ACT" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
      <statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
        <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96" displayName="Type 2 diabetes mellitus">
          <translation code="E11.9" codeSystem="2.16.840.1.113883.6.90" displayName="Type 2 diabetes mellitus without complications"/>
        </value>
      </observation></entryRelationship>
    </act></entry>
  </section></component>`;

// A portal container. `stamp` stands in for the packaging metadata a portal
// regenerates on every request, so two collections differ byte for byte.
function container(stamp: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${body}
  </structuredBody></component>
</ClinicalDocument>`;
}

const MULTI_VISIT_BODY =
  encountersSection(
    encounter("900001", "20190402"),
    encounter("900002", "20190815")
  ) + VISIT_DX_SECTION;

const SINGLE_VISIT_BODY = VISIT_DX_SECTION;

function upload(xml: string, name: string): File {
  return new File([Buffer.from(xml)], name, { type: "application/xml" });
}

describe("uncorrelated visit diagnoses in a multi-visit container (#2917)", () => {
  it("imports with NO onset, and an external_id carrying no date", () => {
    const profile = newProfile("Container Visitor");
    const docId = newDocument(profile, "all-visits.xml");
    importXml(profile, docId, container("20190901", MULTI_VISIT_BODY));

    const rows = conditionRows(profile);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Essential hypertension");
    // The container's effectiveTime belonged to no visit in it.
    expect(rows[0].onsetDate).toBeNull();
    expect(rows[0].externalId).toContain("ccda:visit-dx:");
    // No date in the identity, so a re-collection cannot mint a new one.
    expect(rows[0].externalId).toMatch(/ccda:visit-dx:[^|]*:$/);
    // Chronic-capable, so the status intelligence leaves it alone (#590).
    expect(rows[0].status).toBe("active");
  });

  it("keeps the document date as onset when the document IS one visit", () => {
    const profile = newProfile("Single Visit");
    const docId = newDocument(profile, "one-visit.xml");
    importXml(profile, docId, container("20190402", SINGLE_VISIT_BODY));

    const rows = conditionRows(profile);
    expect(rows).toHaveLength(1);
    // There the document date genuinely IS the visit date (#590's premise).
    expect(rows[0].onsetDate).toBe("2019-04-02");
    expect(rows[0].externalId).toContain("2019-04-02");
  });

  it("mints the SAME external_id for two collections of one visit list", () => {
    const early = newProfile("Collected July");
    const earlyDoc = newDocument(early, "collected-1.xml");
    importXml(early, earlyDoc, container("20190901", MULTI_VISIT_BODY));

    const late = newProfile("Collected August");
    const lateDoc = newDocument(late, "collected-2.xml");
    // Same clinical content, a container generated a month later.
    importXml(late, lateDoc, container("20191015", MULTI_VISIT_BODY));

    // The stored value is document-scoped (`document:<id>|…`, per scopedExternalId);
    // the IDENTITY the #1780 clinical key reads is the part after the prefix.
    const identity = (v: string) => v.slice(v.indexOf("|") + 1);
    expect(identity(conditionRows(late)[0].externalId)).toBe(
      identity(conditionRows(early)[0].externalId)
    );
  });

  it("restores #1780's refusal for a re-collected container", async () => {
    const { login, profile } = seedActor();
    const first = container("20190901", MULTI_VISIT_BODY);
    const second = container("20191015", MULTI_VISIT_BODY);
    expect(second).not.toBe(first);

    await ingestMedicalUpload(login.id, profile.id, upload(first, "first.xml"));
    const conditionsAfterFirst = conditionRows(profile.id).length;
    expect(conditionsAfterFirst).toBe(1);

    const out = await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(second, "second.xml"),
      { acquirer: true }
    );
    // The fallback onset used to make the two containers different clinical content.
    expect(out.refusal).toBe("already-imported");
    expect(conditionRows(profile.id)).toHaveLength(conditionsAfterFirst);
  });
});

describe("pregnancy-state and administrative codes (#2917)", () => {
  it("imports them resolved, and leaves real conditions active", () => {
    const profile = newProfile("Postpartum Person");
    const docId = newDocument(profile, "problems.xml");
    importXml(profile, docId, container("20190901", PREGNANCY_ADMIN_PROBLEMS));

    const byName = new Map(conditionRows(profile).map((r) => [r.name, r]));
    expect(byName.get("Normal pregnancy in first trimester")!.status).toBe(
      "resolved"
    );
    expect(byName.get("Primigravida in third trimester")!.status).toBe(
      "resolved"
    );
    expect(byName.get("Postpartum care and examination")!.status).toBe(
      "resolved"
    );
    expect(byName.get("Need for Tdap vaccination")!.status).toBe("resolved");
    // The one real standing problem in the section is untouched.
    expect(byName.get("Type 2 diabetes mellitus")!.status).toBe("active");
  });

  it("leaves the conditions page with one active problem, not five", () => {
    const profile = newProfile("Conditions Page");
    const docId = newDocument(profile, "problems.xml");
    importXml(profile, docId, container("20190901", PREGNANCY_ADMIN_PROBLEMS));

    const active = getConditions(profile, { status: "active" });
    expect(active.map((c) => c.name)).toEqual(["Type 2 diabetes mellitus"]);
  });

  it("heals an already-imported document on reprocess", () => {
    const profile = newProfile("Reprocessed");
    const docId = newDocument(profile, "problems.xml");
    importXml(profile, docId, container("20190901", PREGNANCY_ADMIN_PROBLEMS));
    // Simulate the pre-fix rows the prod export left behind: permanently active.
    db.prepare(
      `UPDATE conditions SET status = 'active'
        WHERE profile_id = ? AND document_id = ?`
    ).run(profile, docId);
    expect(getConditions(profile, { status: "active" })).toHaveLength(5);

    // The established reprocess path replaces the document's rows (#2917 decision 3:
    // existing rows heal by reprocess, no migration).
    importXml(profile, docId, container("20190901", PREGNANCY_ADMIN_PROBLEMS));
    expect(
      getConditions(profile, { status: "active" }).map((c) => c.name)
    ).toEqual(["Type 2 diabetes mellitus"]);
  });
});
