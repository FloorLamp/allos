// DB INTEGRATION TIER (npm run test:db). The content-hash document tombstone (#1777) —
// the substrate that makes #1776's inventory endpoint safe to diff against.
//
// WHAT IS BEING PINNED. Deleting a document must leave a memory of the deletion keyed on
// its content hash, so an acquirer re-offering the same bytes is refused instead of
// silently resurrecting a document the user removed. The pieces:
//
//   1. migration 134's nullable `label` column exists and holds the filename captured at
//      delete time (the natural key is an opaque hash; the Review list has to name what
//      it is blocking);
//   2. deleteMedicalDocument writes the tombstone, for a portal-acquired AND a manually
//      uploaded document alike — provenance changes the confirm COPY, never whether the
//      deletion is remembered;
//   3. the tombstone rows are PROFILE-SCOPED: one profile's deletion never blocks
//      another's bytes;
//   4. a re-delete of the same bytes refreshes the label rather than duplicating the row
//      (the UNIQUE natural key), and clearing is idempotent with a typed answer;
//   5. reassigning a document to a profile that had tombstoned those bytes CLEARS that
//      tombstone — otherwise #1776 would answer `held` and `deleted` for one hash.
//
// The upload-path REFUSAL that consumes these rows is pinned in
// document-tombstone-ingest.test.ts; this file owns the store.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import {
  clearDocumentTombstone,
  isDocumentTombstoned,
  listDocumentTombstones,
  tombstonedDocumentHashes,
  writeDocumentTombstone,
} from "@/lib/document-tombstones";
import {
  deleteMedicalDocument,
  reassignDocument,
} from "@/app/(app)/medical/document-actions";
import {
  actAs,
  createLogin,
  createProfile,
  fd,
  seedActor,
} from "@/lib/__action_tests__/harness";

// A stored document row for a profile. Low-entropy, obviously-fictional hashes on
// purpose: a realistic sha-256 literal is what trips the repo's secret scanning.
function insertDoc(
  profileId: number,
  filename: string,
  contentHash: string,
  opts: { acquiredPortalId?: number | null; storedPath?: string } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (filename, stored_path, mime_type, size_bytes, content_hash,
            extraction_status, uploaded_at, profile_id, acquired_portal_id)
         VALUES (?,?,?,?,?, 'done', ?, ?, ?)`
      )
      .run(
        filename,
        opts.storedPath ?? `data/uploads/medical/${profileId}/${filename}`,
        "application/pdf",
        1024,
        contentHash,
        sqlNow(),
        profileId,
        opts.acquiredPortalId ?? null
      ).lastInsertRowid
  );
}

function createPortal(name: string, slug: string): number {
  return Number(
    db.prepare("INSERT INTO portals (slug, name) VALUES (?, ?)").run(slug, name)
      .lastInsertRowid
  );
}

describe("migration 134 — import_tombstones.label", () => {
  it("adds a nullable label column that existing writers leave null", () => {
    const cols = db.prepare("PRAGMA table_info(import_tombstones)").all() as {
      name: string;
      notnull: number;
    }[];
    const label = cols.find((c) => c.name === "label");
    expect(label).toBeDefined();
    // Nullable: every pre-existing tombstone (activity / body-metric / medical-record)
    // has no filename and never will, and none of them are backfilled.
    expect(label?.notnull).toBe(0);

    const { profile } = seedActor();
    db.prepare(
      `INSERT INTO import_tombstones (profile_id, target_table, natural_key)
       VALUES (?, 'activities', 'strava:tombstone-label-check')`
    ).run(profile.id);
    const row = db
      .prepare(
        `SELECT label FROM import_tombstones
          WHERE profile_id = ? AND target_table = 'activities'`
      )
      .get(profile.id) as { label: string | null };
    expect(row.label).toBeNull();
  });
});

describe("document tombstone store", () => {
  it("writes, reads, and clears on the content hash", () => {
    const { profile } = seedActor();
    const hash = "e2e-doc-hash-store-1";

    expect(isDocumentTombstoned(profile.id, hash)).toBe(false);
    writeDocumentTombstone(profile.id, hash, "labs-march.pdf");
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);
    expect(tombstonedDocumentHashes(profile.id)).toContain(hash);

    const listed = listDocumentTombstones(profile.id).find(
      (t) => t.contentHash === hash
    );
    expect(listed?.label).toBe("labs-march.pdf");
    expect(listed?.deletedAt).toBeTruthy();

    // Clearing answers whether it actually removed anything — the allow-again action
    // renders that outcome instead of confirming a write that may not have happened.
    expect(clearDocumentTombstone(profile.id, hash)).toBe(true);
    expect(clearDocumentTombstone(profile.id, hash)).toBe(false);
    expect(isDocumentTombstoned(profile.id, hash)).toBe(false);
  });

  it("is idempotent on the natural key and refreshes the label", () => {
    const { profile } = seedActor();
    const hash = "e2e-doc-hash-store-2";

    writeDocumentTombstone(profile.id, hash, "first-name.pdf");
    writeDocumentTombstone(profile.id, hash, "second-name.pdf");

    const rows = db
      .prepare(
        `SELECT label FROM import_tombstones
          WHERE profile_id = ? AND target_table = 'medical_documents'
            AND natural_key = ?`
      )
      .all(profile.id, hash) as { label: string }[];
    // One row, not two — the UNIQUE(profile_id, target_table, natural_key) index.
    expect(rows).toHaveLength(1);
    // …carrying the name a user would recognize most recently.
    expect(rows[0].label).toBe("second-name.pdf");
  });

  it("scopes to the profile — one profile's deletion never blocks another's bytes", () => {
    const a = seedActor();
    const b = seedActor();
    const hash = "e2e-doc-hash-scope-1";

    writeDocumentTombstone(a.profile.id, hash, "a.pdf");

    expect(isDocumentTombstoned(a.profile.id, hash)).toBe(true);
    expect(isDocumentTombstoned(b.profile.id, hash)).toBe(false);
    expect(tombstonedDocumentHashes(b.profile.id)).not.toContain(hash);
    expect(clearDocumentTombstone(b.profile.id, hash)).toBe(false);
    // …and the other profile's row survived that no-op delete.
    expect(isDocumentTombstoned(a.profile.id, hash)).toBe(true);
  });
});

describe("deleteMedicalDocument writes the tombstone", () => {
  it("records the hash and the filename for a portal-acquired document", async () => {
    const { profile } = seedActor();
    const portalId = createPortal(
      "Tombstone Portal A",
      `tombstone-portal-a-${profile.id}`
    );
    const hash = "e2e-doc-hash-delete-1";
    const docId = insertDoc(profile.id, "portal-ccd.xml", hash, {
      acquiredPortalId: portalId,
    });

    await deleteMedicalDocument(fd({ id: docId }));

    expect(
      db.prepare("SELECT id FROM medical_documents WHERE id = ?").get(docId)
    ).toBeUndefined();
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);
    // The label is the only way the Review list can name what it is blocking — the
    // natural key is an opaque hash and the row it came from is gone.
    expect(
      listDocumentTombstones(profile.id).find((t) => t.contentHash === hash)
        ?.label
    ).toBe("portal-ccd.xml");
  });

  it("records it for a manually uploaded document too", async () => {
    const { profile } = seedActor();
    const hash = "e2e-doc-hash-delete-2";
    const docId = insertDoc(profile.id, "hand-upload.pdf", hash);

    await deleteMedicalDocument(fd({ id: docId }));

    // Provenance decides what the confirm dialog SAYS, never whether the deletion is
    // remembered: the hash is the identity whichever path first brought the bytes in.
    expect(isDocumentTombstoned(profile.id, hash)).toBe(true);
  });

  it("writes nothing for a document that never had a content hash", async () => {
    const { profile } = seedActor();
    const docId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (filename, stored_path, mime_type, size_bytes, extraction_status,
              uploaded_at, profile_id)
           VALUES (?,?,?,?, 'failed', ?, ?)`
        )
        .run("too-big.pdf", "", "application/pdf", 9, sqlNow(), profile.id)
        .lastInsertRowid
    );

    await deleteMedicalDocument(fd({ id: docId }));

    // A 'failed' marker never got bytes, so there is nothing an acquirer could match
    // and nothing to block.
    expect(listDocumentTombstones(profile.id)).toHaveLength(0);
  });
});

describe("reassignDocument reconciles the destination's tombstone", () => {
  it("clears a destination tombstone for bytes it now genuinely holds", async () => {
    const login = createLogin({ role: "admin" });
    const src = createProfile(`Reassign src ${login.id}`, login.id);
    const dest = createProfile(`Reassign dest ${login.id}`, login.id);
    const hash = "e2e-doc-hash-reassign-1";

    // The destination previously deleted these exact bytes.
    writeDocumentTombstone(dest.id, hash, "old-copy.pdf");

    actAs(login, src);
    const docId = insertDoc(src.id, "misfiled.pdf", hash);
    const res = await reassignDocument(
      fd({ id: docId, destProfileId: dest.id })
    );
    expect(res.status).toBe("done");

    // Held and deleted must stay disjoint: the destination demonstrably has these
    // bytes now, so claiming they are blocked there would be a lie #1776 would repeat.
    expect(isDocumentTombstoned(dest.id, hash)).toBe(false);
    // The SOURCE gets no tombstone — a reassignment corrects FILING, it does not delete
    // content, and the user was told "Document moved."
    expect(isDocumentTombstoned(src.id, hash)).toBe(false);
  });
});
