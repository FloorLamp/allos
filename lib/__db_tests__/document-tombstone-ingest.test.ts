// DB INTEGRATION TIER (npm run test:db). The tombstone's CONSULT POINT (#1777) — the
// acquirer ingest path — plus the inventory answer it feeds (#1776).
//
// THE NO-RESURRECTION PIN. This is the property the whole cluster exists for, end to
// end: a user deletes a document → the inventory lists that hash under `deleted` → an
// acquirer re-offering the same bytes is REFUSED and lands no row. Break any link and a
// document the user deleted comes back on the next nightly run, which is the
// trust-destroying failure #1777 opens with.
//
// The other half is manual-wins: a HUMAN re-upload of the same bytes clears the
// tombstone and stores, because a person putting the file back IS the un-delete intent.
// The engine reports that (`restored`) so no un-blocking happens silently.
//
// The tombstone STORE itself (write/read/clear/scope, the delete action, reassignment)
// is pinned in document-tombstones.test.ts; this file owns what consults it.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { heldDocumentHashes } from "@/lib/medical-pipeline/storage";
import {
  isDocumentTombstoned,
  listDocumentTombstones,
  tombstonedDocumentHashes,
  writeDocumentTombstone,
} from "@/lib/document-tombstones";
import { deleteMedicalDocument } from "@/app/(app)/medical/document-actions";
import { fd, seedActor } from "@/lib/__action_tests__/harness";

// A minimal PDF the content sniff accepts, with per-test bytes so each test owns its
// own content hash and never collides with another's.
function pdf(marker: string): File {
  const body = `%PDF-1.4\n% allos spec document ${marker}\n%%EOF\n`;
  return new File([Buffer.from(body)], `${marker}.pdf`, {
    type: "application/pdf",
  });
}

function docRows(profileId: number) {
  return db
    .prepare(
      `SELECT id, filename, extraction_status AS status, stored_path
         FROM medical_documents WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    filename: string;
    status: string;
    stored_path: string | null;
  }[];
}

describe("acquirer path: a tombstoned hash is refused", () => {
  it("delete → inventory lists it under deleted → re-offer is blocked with NO row", async () => {
    const { login, profile } = seedActor();

    // 1. A portal pushed a document and it stored.
    const first = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("resurrect-1"),
      { acquirer: true }
    );
    expect(first.docId).not.toBeNull();
    expect(first.refusal).toBeNull();
    const hash = first.contentHash;
    expect(hash).toBeTruthy();
    // It is HELD: the inventory would tell a client not to send it again.
    expect(heldDocumentHashes(profile.id)).toContain(hash);

    // 2. The user deletes it.
    await deleteMedicalDocument(fd({ id: first.docId }));
    const afterDelete = docRows(profile.id);
    expect(afterDelete).toHaveLength(0);

    // 3. The inventory now answers `deleted`, and no longer `held`. The two lists are
    //    disjoint — that is what lets a client with NO local state send exactly the
    //    hashes in neither list.
    expect(tombstonedDocumentHashes(profile.id)).toContain(hash);
    expect(heldDocumentHashes(profile.id)).not.toContain(hash);

    // 4. The acquirer re-offers the very same bytes — the diff-and-send a nightly
    //    reconciliation run would do if it ignored the `deleted` list.
    const second = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("resurrect-1"),
      { acquirer: true }
    );

    // REFUSED, and — the load-bearing half — no row of any kind. A 'skipped' marker
    // would be an audit trail of an event that the sync report already records, and it
    // would make an idempotent retry non-idempotent in the table.
    expect(second.docId).toBeNull();
    expect(second.refusal).toBe("blocked");
    expect(docRows(profile.id)).toHaveLength(0);
    // The deletion is still remembered — a refused offer must not consume the tombstone.
    expect(isDocumentTombstoned(profile.id, hash!)).toBe(true);
  });

  it("blocks repeatedly — a nightly run never wears the tombstone down", async () => {
    const { login, profile } = seedActor();
    const stored = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("resurrect-2"),
      { acquirer: true }
    );
    await deleteMedicalDocument(fd({ id: stored.docId }));

    for (let run = 0; run < 3; run++) {
      const offer = await ingestMedicalUpload(
        login.id,
        profile.id,
        pdf("resurrect-2"),
        { acquirer: true }
      );
      expect(offer.refusal).toBe("blocked");
      expect(offer.docId).toBeNull();
    }
    expect(docRows(profile.id)).toHaveLength(0);
  });

  it("an already-held offer lands NO marker row either (#1776)", async () => {
    const { login, profile } = seedActor();
    const first = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("already-held-1"),
      { acquirer: true }
    );
    expect(first.docId).not.toBeNull();
    expect(docRows(profile.id)).toHaveLength(1);

    const again = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("already-held-1"),
      { acquirer: true }
    );

    // The offer is recognized and refused a row: forcing already-held documents used to
    // double the portal-acquired count with 'skipped' rows that stored nothing.
    expect(again.docId).toBeNull();
    expect(again.refusal).toBe("already-held");
    expect(docRows(profile.id)).toHaveLength(1);
  });

  it("never un-deletes: an acquirer offer leaves the tombstone standing", async () => {
    const { login, profile } = seedActor();
    const hash = "e2e-doc-hash-never-undelete";
    writeDocumentTombstone(profile.id, hash, "blocked.pdf");

    // Not the same bytes as the tombstone above — this only proves the acquirer path
    // has no tombstone-clearing branch at all, for any file.
    const out = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("never-undelete"),
      { acquirer: true }
    );
    expect(out.restored).toBe(false);
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);
  });

  it("scopes the refusal to the profile that deleted", async () => {
    const a = seedActor();
    const b = seedActor();

    const stored = await ingestMedicalUpload(
      a.login.id,
      a.profile.id,
      pdf("scoped-block"),
      { acquirer: true }
    );
    await deleteMedicalDocument(fd({ id: stored.docId }));

    // The OTHER profile never deleted these bytes, so its acquirer push must land.
    const other = await ingestMedicalUpload(
      b.login.id,
      b.profile.id,
      pdf("scoped-block"),
      { acquirer: true }
    );
    expect(other.refusal).toBeNull();
    expect(other.docId).not.toBeNull();
  });
});

describe("human path: manual wins", () => {
  it("a human re-upload clears the tombstone, stores, and says it restored", async () => {
    const { login, profile } = seedActor();

    const first = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("manual-restore-1"),
      { acquirer: true }
    );
    const hash = first.contentHash!;
    await deleteMedicalDocument(fd({ id: first.docId }));
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);

    // No `acquirer` flag — the upload form / share sheet path.
    const manual = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("manual-restore-1")
    );

    // Stored, not refused: a person putting the file back IS the un-delete intent,
    // exactly as a hand edit wins over a sync.
    expect(manual.refusal).toBeNull();
    expect(manual.docId).not.toBeNull();
    // …and it is reported, so the un-blocking never happens silently — the Review
    // blocked list would otherwise appear to lose an entry with no explanation.
    expect(manual.restored).toBe(true);
    expect(isDocumentTombstoned(profile.id, hash)).toBe(false);
    expect(listDocumentTombstones(profile.id)).toHaveLength(0);

    // The acquirer may now push those bytes again — the block is genuinely lifted, not
    // just hidden from the list.
    const reoffer = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("manual-restore-1"),
      { acquirer: true }
    );
    expect(reoffer.refusal).toBe("already-held");
  });

  it("reports restored:false for an ordinary upload of never-deleted bytes", async () => {
    const { login, profile } = seedActor();
    const out = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("ordinary-upload-1")
    );
    expect(out.restored).toBe(false);
    expect(out.docId).not.toBeNull();
  });

  it("still lands the 'skipped' duplicate marker on the human path", async () => {
    const { login, profile } = seedActor();
    await ingestMedicalUpload(login.id, profile.id, pdf("human-dup-1"));
    const again = await ingestMedicalUpload(
      login.id,
      profile.id,
      pdf("human-dup-1")
    );

    // The acquirer's no-row rule is deliberately NOT generalized: on the form, the row
    // IS the feedback surface — a person who re-picked a file gets to see why nothing
    // happened.
    expect(again.docId).not.toBeNull();
    const rows = docRows(profile.id);
    expect(rows).toHaveLength(2);
    expect(rows[1].status).toBe("skipped");
    expect(rows[1].stored_path).toBe("");
  });
});
