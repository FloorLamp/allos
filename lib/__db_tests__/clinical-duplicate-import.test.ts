// DB INTEGRATION TIER — one person, two portal logins, one set of records (issue #1780).
//
// The reported failure, end to end: a household member is the account holder on one portal
// login and a proxy patient on another, both labels bound to the same profile (correctly —
// they are one person). Collecting through both yields two archives of the same visits.
// The portal regenerates its container per request, so the two differ byte for byte and by
// content hash; both used to upload as `stored`, both extracted, and the profile ended up
// with every encounter attested twice.
//
// These drive the REAL ingest path (ingestMedicalUpload) with two synthetic CCDs whose
// packaging differs and whose clinical entries are identical, and pin: the second one
// imports nothing, the accounting says which document already holds the records, an
// automated client gets a no-row refusal, a genuinely richer export is still accepted, and
// another profile is untouched.
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { seedActor } from "@/lib/__action_tests__/harness";
import { up as backfillClinicalKeys } from "@/lib/migrations/versions/136-clinical-content-key";

const ENCOUNTERS = `
  <component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Encounters</title>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="1.2.3.4" extension="900001"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="20190402"/></effectiveTime>
    </encounter></entry>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="1.2.3.4" extension="900002"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="20190815"/></effectiveTime>
    </encounter></entry>
  </section></component>`;

const RESULTS = `
  <component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
    <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Results</title>
    <entry><organizer classCode="BATTERY" moodCode="EVN">
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="2093-3" codeSystem="2.16.840.1.113883.6.1" displayName="Cholesterol"/>
        <effectiveTime value="20190402"/>
        <value type="PQ" value="188" unit="mg/dL"/>
      </observation></component>
      <component><observation classCode="OBS" moodCode="EVN">
        <code code="2085-9" codeSystem="2.16.840.1.113883.6.1" displayName="HDL Cholesterol"/>
        <effectiveTime value="20190402"/>
        <value type="PQ" value="61" unit="mg/dL"/>
      </observation></component>
    </organizer></entry>
  </section></component>`;

// A THIRD visit, present only in the "richer export" case below.
const EXTRA_ENCOUNTER = `
  <component><section>
    <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
    <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
    <title>Encounters</title>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
      <id root="1.2.3.4" extension="900003"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <effectiveTime><low value="20191220"/></effectiveTime>
    </encounter></entry>
  </section></component>`;

// One portal collection. `stamp` stands in for the per-request packaging metadata a portal
// regenerates every time, so two calls differ byte for byte with identical clinical
// content — the exact thing that defeats the content hash.
function archive(stamp: string, extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    ${ENCOUNTERS}
    ${RESULTS}
    ${extra}
  </structuredBody></component>
</ClinicalDocument>`;
}

function upload(xml: string, name: string): File {
  return new File([Buffer.from(xml)], name, { type: "application/xml" });
}

function docRows(profileId: number) {
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, extraction_error AS error,
              stored_path, content_hash, clinical_key, extracted_count
         FROM medical_documents WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    filename: string;
    status: string;
    error: string | null;
    stored_path: string | null;
    content_hash: string | null;
    clinical_key: string | null;
    extracted_count: number;
  }[];
}

function encounterCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

function recordCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

describe("two portal logins, one profile, one set of records (#1780)", () => {
  it("the second collection imports nothing, and says which document already holds it", async () => {
    const { login, profile } = seedActor();
    const first = archive("20260101090000");
    const second = archive("20260714113000");
    // The premise: a portal never hands back the same bytes twice.
    expect(second).not.toBe(first);

    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(first, "portalA-loginA.xml")
    );
    const afterFirst = docRows(profile.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe("done");
    expect(afterFirst[0].clinical_key).toMatch(/^[0-9a-f]{64}$/);
    const encountersAfterFirst = encounterCount(profile.id);
    const recordsAfterFirst = recordCount(profile.id);
    expect(encountersAfterFirst).toBe(2);

    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(second, "portalA-loginB.xml")
    );

    // The profile's records did NOT double.
    expect(encounterCount(profile.id)).toBe(encountersAfterFirst);
    expect(recordCount(profile.id)).toBe(recordsAfterFirst);

    // The second upload landed the same shape a byte-duplicate does: a file-less
    // 'skipped' marker carrying the reason — so a person sees why nothing happened.
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(2);
    const marker = rows[1];
    expect(marker.status).toBe("skipped");
    expect(marker.stored_path).toBe("");
    expect(marker.extracted_count).toBe(0);
    expect(marker.error).toMatch(/Duplicate records/i);
    // It names the document that DOES hold the records, so nothing looks lost.
    expect(marker.error).toContain("portalA-loginA.xml");
    // The marker states which identity was recognized — the clinical key, not the bytes.
    expect(marker.clinical_key).toBe(afterFirst[0].clinical_key);
    expect(marker.content_hash).not.toBe(afterFirst[0].content_hash);
  });

  it("refuses an automated client's re-collection with NO row at all", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260101090000"), "collected-1.xml"),
      { acquirer: true }
    );
    expect(docRows(profile.id)).toHaveLength(1);

    // A portal's container is never byte-stable, so an acquirer re-collecting on a
    // schedule would land a fresh marker row EVERY run. It gets an event instead.
    const out = await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260714113000"), "collected-2.xml"),
      { acquirer: true }
    );
    expect(out.docId).toBeNull();
    expect(out.refusal).toBe("already-imported");
    expect(docRows(profile.id)).toHaveLength(1);
    expect(encounterCount(profile.id)).toBe(2);
  });

  it("still accepts an export that genuinely carries a visit the first did not", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260101090000"), "first.xml")
    );
    expect(encounterCount(profile.id)).toBe(2);

    // Exact set equality is the rule: a SUPERSET is not the same records, so it imports.
    // Refusing it would lose the third visit — the error direction that matters, because
    // a dedup decision DISCARDS an offer.
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260714113000", EXTRA_ENCOUNTER), "second.xml")
    );
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("done");
    expect(rows[1].clinical_key).not.toBe(rows[0].clinical_key);
    // The new visit arrived.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ? AND date = '2019-12-20'"
        )
        .get(profile.id)
    ).toEqual({ n: 1 });
    // And the PARTIAL-overlap case is deliberately left exactly as it was: the two shared
    // visits are still attested once per document (2 + 3 = 5), because import-persist
    // scopes each row's external_id to its own document so deleting one never orphans the
    // other. Collapsing those onto one row means deciding what a row backed by two
    // documents does on delete, on reprocess and on conflicting values — the open
    // questions #1780 raises and does not settle. This fix takes the case the issue
    // MEASURED (identical sets) and leaves the undecided one untouched rather than
    // guessing.
    expect(encounterCount(profile.id)).toBe(5);
  });

  it("is profile-scoped — one person's archive never suppresses another's", async () => {
    const a = seedActor();
    const b = seedActor();
    await ingestMedicalUpload(
      a.login.id,
      a.profile.id,
      upload(archive("20260101090000"), "a.xml")
    );
    await ingestMedicalUpload(
      b.login.id,
      b.profile.id,
      upload(archive("20260714113000"), "b.xml")
    );
    expect(docRows(b.profile.id)[0].status).toBe("done");
    expect(encounterCount(b.profile.id)).toBe(2);
  });

  it("a byte-identical re-upload still takes the content-hash path, unchanged", async () => {
    const { login, profile } = seedActor();
    const same = archive("20260101090000");
    await ingestMedicalUpload(login.id, profile.id, upload(same, "same.xml"));
    await ingestMedicalUpload(login.id, profile.id, upload(same, "same.xml"));
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(2);
    // The byte recognition owns its own wording, and asserts no clinical identity for a
    // file it never had to parse.
    expect(rows[1].error).toMatch(/Duplicate upload/i);
    expect(rows[1].clinical_key).toBeNull();
  });

  it("an un-parseable file is stored and reported, never silently deduped", async () => {
    const { login, profile } = seedActor();
    // Looks like a CDA to the sniffer, but the body is broken. The probe must yield no
    // key and get out of the way so the real import records the parse error on the row.
    const broken =
      '<?xml version="1.0"?><ClinicalDocument xmlns="urn:hl7-org:v3"><component>';
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(broken, "broken.xml")
    );
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).not.toBe("skipped");
  });
});

describe("migration 136 backfill", () => {
  it("recovers a document's clinical key from the external_ids its rows already carry", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260101090000"), "history.xml")
    );
    const [doc] = docRows(profile.id);
    const live = doc.clinical_key;
    expect(live).toMatch(/^[0-9a-f]{64}$/);

    // Stand in for a document imported before the column existed.
    db.prepare(
      "UPDATE medical_documents SET clinical_key = NULL WHERE id = ? AND profile_id = ?"
    ).run(doc.id, profile.id);

    backfillClinicalKeys(db);

    // The recovered key equals the one a live import computes — so an archive collected
    // AFTER the upgrade is recognized against history, not only against new documents.
    expect(docRows(profile.id)[0].clinical_key).toBe(live);
  });

  it("leaves an already-keyed document alone (idempotent replay)", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260101090000"), "keyed.xml")
    );
    const before = docRows(profile.id)[0].clinical_key;
    backfillClinicalKeys(db);
    expect(docRows(profile.id)[0].clinical_key).toBe(before);
  });
});
