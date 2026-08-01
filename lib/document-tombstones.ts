// CONTENT-HASH DOCUMENT TOMBSTONES (issue #1777) — "the user deleted these bytes, and an
// acquirer may not put them back."
//
// ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
//
// `deleteMedicalDocument` drops the row, its imported children, and the stored file. The
// content hash left no trace, so a re-offer of the same bytes was INDISTINGUISHABLE from
// a first offer. That was survivable only while acquirers had no way to ask what allos
// holds — the moment #1776's inventory endpoint invites diff-and-send, "user deletes a
// document" silently becomes "it comes back tomorrow morning". The documents people
// delete from a portal feed are junk pages, wrong-patient bindings, and things they
// specifically do not want held, so that is the worst possible thing to resurrect.
//
// Everywhere else in allos a user's deletion of imported data is already authoritative:
// the #507/#508 re-import tombstones exist precisely so an idempotent re-sync can never
// resurrect a deleted row, and `suppressed` is a first-class accounting category rather
// than a silent drop. This is that doctrine, applied to documents.
//
// ── WHY IT REUSES `import_tombstones` AND NOT A NEW TABLE ────────────────────
//
// `import_tombstones` is already `(profile_id, target_table, natural_key)` with a UNIQUE
// index and a settled write/remove discipline. A document slots in as
// `target_table = 'medical_documents'`, `natural_key = <content_hash>` — and the hash is
// ALREADY the document's identity (storage.ts::findDedupTarget dedups on exactly it), so
// nothing had to be invented. A second holding table would have been a second thing to
// keep consistent with the first, for no new fact.
//
// ── WHY THIS IS ITS OWN MODULE, NOT A ROW IN `TOMBSTONE_TABLES` ──────────────
//
// The existing entries are consulted by the KEYED UPSERTS in
// lib/integrations/normalize.ts, which walk `TOMBSTONE_TABLES` and skip a would-be
// re-insert. The document tombstone's consult point is a different one entirely: the
// ACQUIRER INGEST PATH (lib/medical-pipeline.ts), which refuses the offered file before
// any row exists. Adding 'medical_documents' to TOMBSTONE_TABLES would tell every keyed
// upsert to load a tombstone set for a table it never writes. So the two halves share
// the storage and nothing else, which is the asymmetry #1777 chose to document rather
// than force.
//
// AUTH-BLIND, `profileId` FIRST, per the write-core rule: every statement here filters
// on `profile_id`, and authorization happens at the Server Action / route boundary.

import { db } from "@/lib/db";

// The `target_table` discriminator for a document tombstone. A literal rather than a
// member of `TombstoneTable`, for the reason in the header: this row shares the storage
// with the keyed-upsert tombstones, not their consult path.
export const DOCUMENT_TOMBSTONE_TABLE = "medical_documents";

// One blocked document, as the Data → Review list renders it.
export interface DocumentTombstone {
  // The sha-256 content hash that is blocked — the document's identity.
  contentHash: string;
  // The filename captured at delete time (migration 134), or null for a row written
  // before that column existed. The UI falls back to a hash prefix.
  label: string | null;
  // When the delete happened.
  deletedAt: string;
}

// Record that this profile deleted a document with these bytes.
//
// Idempotent on the natural key, and the label is REFRESHED on conflict: if the same
// bytes are uploaded under a new filename and deleted again, the name a user would
// recognize is the most recent one. Callers run this INSIDE the delete's existing
// `writeTx`, so the tombstone and the row's disappearance are one atomic fact — there is
// no window in which the document is gone but the deletion is not remembered.
export function writeDocumentTombstone(
  profileId: number,
  contentHash: string,
  label: string | null
): void {
  db.prepare(
    `INSERT INTO import_tombstones (profile_id, target_table, natural_key, label)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, target_table, natural_key)
       DO UPDATE SET label = excluded.label`
  ).run(profileId, DOCUMENT_TOMBSTONE_TABLE, contentHash, label);
}

// Is a re-offer of these bytes refused for this profile?
export function isDocumentTombstoned(
  profileId: number,
  contentHash: string
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM import_tombstones
        WHERE profile_id = ? AND target_table = ? AND natural_key = ?`
    )
    .get(profileId, DOCUMENT_TOMBSTONE_TABLE, contentHash) as
    { hit: number } | undefined;
  return !!row;
}

// Un-block these bytes. Returns whether a tombstone was actually removed, so the caller
// can render a TYPED outcome instead of confirming unconditionally — the row may already
// be gone (two tabs, or a human re-upload cleared it first), and "Allowed again" would
// then be a claim about a write that did not happen.
//
// TWO CALLERS, both of them a person's deliberate act:
//   • the Allow-again action on Data → Review;
//   • a HUMAN upload of the same bytes — a person putting the file back IS the un-delete
//     intent, exactly as the manual-edit lock lets a hand correction win over a sync.
// An acquirer never reaches this: nothing an automated client does may clear a deletion.
export function clearDocumentTombstone(
  profileId: number,
  contentHash: string
): boolean {
  const info = db
    .prepare(
      `DELETE FROM import_tombstones
        WHERE profile_id = ? AND target_table = ? AND natural_key = ?`
    )
    .run(profileId, DOCUMENT_TOMBSTONE_TABLE, contentHash);
  return info.changes > 0;
}

// Every blocked document for this profile, newest deletion first — the Data → Review
// list, and nothing else reads it.
export function listDocumentTombstones(profileId: number): DocumentTombstone[] {
  return db
    .prepare(
      `SELECT natural_key AS contentHash, label, created_at AS deletedAt
         FROM import_tombstones
        WHERE profile_id = ? AND target_table = ?
        ORDER BY created_at DESC, id DESC`
    )
    .all(profileId, DOCUMENT_TOMBSTONE_TABLE) as DocumentTombstone[];
}

// Just the hashes — the `deleted` half of #1776's inventory answer. Kept separate from
// the list above because the wire shape must carry hashes ONLY: a filename is household
// information, and the inventory endpoint has no business handing an automated client
// the names of documents a person deleted.
export function tombstonedDocumentHashes(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT natural_key AS contentHash FROM import_tombstones
          WHERE profile_id = ? AND target_table = ?
          ORDER BY natural_key`
      )
      .all(profileId, DOCUMENT_TOMBSTONE_TABLE) as { contentHash: string }[]
  ).map((r) => r.contentHash);
}
