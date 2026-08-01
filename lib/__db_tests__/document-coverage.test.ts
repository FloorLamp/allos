// DB INTEGRATION TIER — the coverage marker and the third inventory list (issue #1828).
//
// THE LOOP THIS PINS SHUT. An acquirer asks the inventory what to send, and #1776's rule
// is "send exactly the hashes in neither list". A `duplicate` refusal stores NOTHING
// (#1781), so its hash was in neither list, so the rule said "send it" — on every run,
// forever, for the same 1.7 MB, refused identically each time. #1786 made that an ORDINARY
// household configuration rather than an anomaly.
//
// The property, end to end: an acquirer pushes a collection → it stores → a second
// collection of the SAME records in different packaging is refused with no row → its hash
// now answers `covered` → a client following the rule stops offering it → and the moment
// the covering document goes, the hash leaves `covered` on the very next read, with no
// write in between and nothing having told the client anything.
//
// The verdict is recomputed, never stored: delete, reprocess-into-a-different-set and
// reassign-away are each pinned below, and none of them touches the marker.
//
// SYNTHETIC ONLY: fictional names, low-entropy values, deep-past clinical dates.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { heldDocumentHashes } from "@/lib/medical-pipeline/storage";
import { tombstonedDocumentHashes } from "@/lib/document-tombstones";
import { coveredDocumentHashes } from "@/lib/document-coverage";
import {
  deleteMedicalDocument,
  reassignDocument,
} from "@/app/(app)/medical/document-actions";
import { actAs, fd, seedActor } from "@/lib/__action_tests__/harness";

// One portal collection. `stamp` stands in for the per-request packaging metadata a portal
// regenerates every time, so two calls differ byte for byte while every clinical entry is
// identical — the exact thing that defeats a content hash and produces the `duplicate`
// verdict this feature is about.
function archive(stamp: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3">
  <id root="1.2.3.4" extension="${stamp}"/>
  <effectiveTime value="${stamp}"/>
  <recordTarget><patientRole><patient>
    <name><given>Robin</given><family>Sample</family></name>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.22.1"/>
      <code code="46240-8" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Encounters</title>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="910001"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190402"/></effectiveTime>
      </encounter></entry>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="910002"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20190815"/></effectiveTime>
      </encounter></entry>
      <entry><encounter classCode="ENC" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.49"/>
        <id root="1.2.3.4" extension="910003"/>
        <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
        <effectiveTime><low value="20191104"/></effectiveTime>
      </encounter></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;
}

function upload(xml: string, name: string): File {
  return new File([Buffer.from(xml)], name, { type: "application/xml" });
}

function markers(profileId: number) {
  return db
    .prepare(
      `SELECT content_hash AS contentHash, clinical_key AS clinicalKey,
              refused_at AS refusedAt
         FROM document_coverage_markers WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    contentHash: string;
    clinicalKey: string;
    refusedAt: string;
  }[];
}

function docCount(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM medical_documents WHERE profile_id = ?"
      )
      .get(profileId) as { n: number }
  ).n;
}

// A collection stored by an acquirer, and the id of the document it landed on.
async function collect(
  loginId: number,
  profileId: number,
  xml: string,
  name: string
) {
  return ingestMedicalUpload(loginId, profileId, upload(xml, name), {
    acquirer: true,
  });
}

describe("a refused duplicate stops being offered forever (#1828)", () => {
  it("refuse → the hash answers `covered` → and it is in neither other list", async () => {
    const { login, profile } = seedActor();

    // Run 1: the first collection stores.
    const first = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "run-1.xml"
    );
    expect(first.docId).not.toBeNull();
    expect(docCount(profile.id)).toBe(1);

    // Run 2: the same visits, repackaged. Refused, and nothing stored — which is exactly
    // why the two-list contract had no way to express it.
    const second = await collect(
      login.id,
      profile.id,
      archive("20260714113000"),
      "run-2.xml"
    );
    expect(second.refusal).toBe("already-imported");
    expect(second.docId).toBeNull();
    expect(docCount(profile.id)).toBe(1);
    const refusedHash = second.contentHash!;

    // The refusal is REMEMBERED — the evidence, not the verdict.
    const rows = markers(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].contentHash).toBe(refusedHash);

    // And the inventory now has an answer for it. Before this, a client applying the
    // documented rule re-sent these bytes on every run for the life of the instance.
    expect(coveredDocumentHashes(profile.id)).toEqual([refusedHash]);
    expect(heldDocumentHashes(profile.id)).not.toContain(refusedHash);
    expect(tombstonedDocumentHashes(profile.id)).not.toContain(refusedHash);
  });

  it("converges: a re-offer of the same bytes refreshes ONE marker, never a second", async () => {
    const { login, profile } = seedActor();
    await collect(login.id, profile.id, archive("20260101090000"), "a.xml");

    const repackaged = archive("20260714113000");
    for (let run = 0; run < 3; run++) {
      const out = await collect(
        login.id,
        profile.id,
        repackaged,
        `retry-${run}.xml`
      );
      expect(out.refusal).toBe("already-imported");
    }
    // Idempotent per (profile, hash): the table records WHICH file is being refused, not
    // how many times a client asked.
    expect(markers(profile.id)).toHaveLength(1);
    expect(docCount(profile.id)).toBe(1);
  });

  it("only a RECORDS duplicate marks coverage — a held or blocked offer does not", async () => {
    const { login, profile } = seedActor();
    const stored = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "held.xml"
    );

    // Same BYTES: already answered by `held`, so there is nothing a third list could add.
    const again = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "held-again.xml"
    );
    expect(again.refusal).toBe("already-held");
    expect(markers(profile.id)).toHaveLength(0);

    // Deleted bytes: already answered by `deleted`, and conflating a person's decision
    // with the engine's is the reason this is not the tombstone table.
    actAs(login, profile);
    await deleteMedicalDocument(fd({ id: stored.docId }));
    const blocked = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "blocked.xml"
    );
    expect(blocked.refusal).toBe("blocked");
    expect(markers(profile.id)).toHaveLength(0);
  });

  it("a PERSON's duplicate upload leaves no marker — the visible row is their feedback", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260101090000"), "mine.xml")
    );
    await ingestMedicalUpload(
      login.id,
      profile.id,
      upload(archive("20260714113000"), "mine-again.xml")
    );
    // The human path lands a 'skipped' marker row saying why nothing happened, and the
    // coverage table is about what an automated client should stop OFFERING.
    expect(docCount(profile.id)).toBe(2);
    expect(markers(profile.id)).toHaveLength(0);
  });

  it("is profile-scoped — one person's refusal never silences another's collection", async () => {
    const a = seedActor();
    const b = seedActor();
    await collect(a.login.id, a.profile.id, archive("20260101090000"), "a.xml");
    const refused = await collect(
      a.login.id,
      a.profile.id,
      archive("20260714113000"),
      "a2.xml"
    );
    expect(refused.refusal).toBe("already-imported");

    expect(markers(b.profile.id)).toHaveLength(0);
    expect(coveredDocumentHashes(b.profile.id)).toEqual([]);
    // The very same repackaged bytes are a FIRST offer for another person, and store.
    const forB = await collect(
      b.login.id,
      b.profile.id,
      archive("20260714113000"),
      "b.xml"
    );
    expect(forB.refusal).toBeNull();
    expect(forB.docId).not.toBeNull();
  });
});

describe("coverage is recomputed at read, never stored (#1828)", () => {
  it("deleting the covering document drops the hash from `covered` — with NO write between", async () => {
    const { login, profile } = seedActor();
    const first = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "covering.xml"
    );
    const refused = await collect(
      login.id,
      profile.id,
      archive("20260714113000"),
      "covered.xml"
    );
    const refusedHash = refused.contentHash!;
    expect(coveredDocumentHashes(profile.id)).toContain(refusedHash);

    // The person deletes the document that made the other one redundant.
    actAs(login, profile);
    await deleteMedicalDocument(fd({ id: first.docId }));

    // The marker is UNTOUCHED — there is no invalidation hook to forget to call...
    expect(markers(profile.id)).toHaveLength(1);
    // ...and the answer changed anyway, because the verdict is a read.
    expect(coveredDocumentHashes(profile.id)).toEqual([]);
  });

  it("and the client's next offer of those bytes then STORES", async () => {
    const { login, profile } = seedActor();
    const first = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "covering.xml"
    );
    const repackaged = archive("20260714113000");
    const refused = await collect(
      login.id,
      profile.id,
      repackaged,
      "covered.xml"
    );
    actAs(login, profile);
    await deleteMedicalDocument(fd({ id: first.docId }));

    const reoffered = await collect(
      login.id,
      profile.id,
      repackaged,
      "covered-again.xml"
    );
    // Not "skip a document allos would now accept" — the failure a client-side memory of
    // "it said duplicate" would have caused.
    expect(reoffered.refusal).toBeNull();
    expect(reoffered.docId).not.toBeNull();
    expect(reoffered.contentHash).toBe(refused.contentHash);

    // Now those bytes ARE held, so `covered` stops claiming the records live elsewhere:
    // the lists stay disjoint without anything sweeping the stale marker.
    const hash = refused.contentHash!;
    expect(heldDocumentHashes(profile.id)).toContain(hash);
    expect(coveredDocumentHashes(profile.id)).not.toContain(hash);
  });

  it("a reprocess that changes the covering entry set re-evaluates on the next read", async () => {
    const { login, profile } = seedActor();
    await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "before.xml"
    );
    const refused = await collect(
      login.id,
      profile.id,
      archive("20260714113000"),
      "covered.xml"
    );
    const hash = refused.contentHash!;
    expect(coveredDocumentHashes(profile.id)).toContain(hash);

    // Stand in for a reprocess whose parse yielded a DIFFERENT entry set: the document is
    // still held, but it no longer carries the identity that covered those bytes.
    db.prepare(
      "UPDATE medical_documents SET clinical_key = ? WHERE profile_id = ?"
    ).run("e2e-clinical-key-after-reprocess-1", profile.id);

    expect(coveredDocumentHashes(profile.id)).toEqual([]);
  });

  it("reassigning the covering document away drops the hash for the old profile", async () => {
    const { login, profile } = seedActor();
    const dest = seedActor({ profileName: "Coverage Destination" });
    // The destination must be reachable by the acting login for the move to be allowed.
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(login.id, dest.profile.id);

    const first = await collect(
      login.id,
      profile.id,
      archive("20260101090000"),
      "moving.xml"
    );
    const refused = await collect(
      login.id,
      profile.id,
      archive("20260714113000"),
      "covered.xml"
    );
    const hash = refused.contentHash!;
    expect(coveredDocumentHashes(profile.id)).toContain(hash);

    actAs(login, profile);
    const moved = await reassignDocument(
      fd({ id: first.docId, destProfileId: dest.profile.id })
    );
    expect(moved.status).toBe("done");

    // The records left with the document, so this profile no longer holds them — and the
    // client is free to offer those bytes here again.
    expect(coveredDocumentHashes(profile.id)).toEqual([]);
    // The marker did not follow the document: it records what THIS profile refused.
    expect(coveredDocumentHashes(dest.profile.id)).toEqual([]);
  });
});
