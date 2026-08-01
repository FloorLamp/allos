// COVERAGE MARKERS (issue #1828) — "an acquirer offered these bytes; allos already holds
// every clinical entry they carry, so it refused them."
//
// ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
//
// #1776's inventory answers `held` and `deleted`, and documents one rule: send exactly the
// hashes in NEITHER list. That rule is right for a document that is stored and for one a
// person deleted, and it has no answer for the third outcome the upload path can return.
//
// A `duplicate` refusal stores NOTHING (#1781): no medical_documents row, no content hash.
// So the refused hash is in neither list — not `held` (nothing was stored) and not
// `deleted` (nobody deleted anything) — and the client's rule therefore says "send it".
// It does, every run, forever, and is refused identically every time. On a live instance
// that was 1.7 MB re-uploaded and re-parsed per run with no convergence.
//
// #1786 made this ordinary rather than exotic: one person reachable through two portal
// logins, both labels bound to one profile, is a configuration the identity model
// explicitly supports — proxy access in a household — so the second export is permanently
// redundant BY DESIGN.
//
// ── WHY THE CLIENT CANNOT FIX IT ALONE ───────────────────────────────────────
//
// A client could remember which hashes came back `duplicate` and stop offering them. That
// reintroduces exactly the staleness the inventory exists to remove, because the verdict
// is NOT stable: delete the document whose entries made this one redundant and the refused
// file becomes storable again, with nothing to tell the client — it is still in neither
// list. It would then skip a document allos would now accept, which is the original bug in
// a new hat. The server computes the verdict and knows when it stops being true, so the
// answer belongs here.
//
// ── EVIDENCE IS STORED; THE VERDICT IS RECOMPUTED ────────────────────────────
//
// The marker records only what was true at the moment of refusal — which bytes were
// offered, and which clinical key (#1780) covered them. Whether that coverage still holds
// is asked at READ time against the documents the profile holds right now. Delete the
// covering document, reassign it away, or reprocess it into a different entry set, and the
// hash silently leaves `covered` and the client re-offers on its very next run. There is
// no invalidation hook to forget to call and no sweep to own.
//
// NOT `import_tombstones` (#1777), deliberately. That table records a PERSON'S decision
// and this records the ENGINE'S, and their rules differ in both directions: a human
// re-upload CLEARS a tombstone (manual wins), while a human re-upload of a covered file
// should simply get the duplicate verdict again — and a tombstone is never swept, while
// coverage is recomputed on every read anyway.
//
// NOT folded into `held`, also deliberately. `held` means "allos has these bytes", and it
// serves the symmetric diff — a client discovering documents allos holds that IT lost
// locally. Folding in bytes allos never stored poisons that use, and a held hash and a
// covered hash have different re-upload semantics.
//
// AUTH-BLIND, `profileId` FIRST, per the write-core rule: every statement filters on
// profile_id, and authorization happens at the route boundary.

import { db } from "@/lib/db";
import { sqlNow } from "@/lib/clock";
import { heldDocumentPredicate } from "@/lib/medical-pipeline/storage";

// Remember that this profile was offered these bytes and refused them as records it
// already holds.
//
// Idempotent on (profile_id, content_hash) and REFRESHED on re-offer, so an acquirer
// re-offering the same file on a schedule keeps exactly one row and `refused_at` reads as
// "still being offered" rather than "seen once in March". The clinical key is refreshed
// too: the same bytes can only ever key one way, but a re-offer arriving after a reprocess
// is worth recording against the key the engine actually recognized this time.
//
// One statement, so it is atomic on its own — callers may run it inside an existing
// writeTx or on its own, and the ingest path does the latter (the refusal has already left
// the reserve transaction, and a marker is an audit fact, not part of the dedup decision).
export function recordCoverageMarker(
  profileId: number,
  contentHash: string,
  clinicalKey: string
): void {
  db.prepare(
    `INSERT INTO document_coverage_markers
       (profile_id, content_hash, clinical_key, refused_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id, content_hash) DO UPDATE SET
       clinical_key = excluded.clinical_key,
       refused_at = excluded.refused_at`
  ).run(profileId, contentHash, clinicalKey, sqlNow());
}

// The `covered` third list of #1776's inventory: hashes this profile does NOT hold, whose
// records it holds anyway — so offering them again is pointless and the client should not.
//
// TWO CONDITIONS, and both are recomputed here rather than stored:
//
//   still covered — the profile holds a document carrying the marker's clinical key. The
//     same HELD predicate the dedup probe uses, so "covered" here and "duplicate" at
//     ingest can never mean two different things. When the covering document goes, the
//     marker stops answering and the client re-offers with nothing to be told.
//
//   not itself held — a marker whose own bytes are now stored (the client re-offered after
//     the covering document was deleted, and that offer landed) is answered by `held`, and
//     `covered` would be claiming the records live under OTHER bytes when they live under
//     these. This clause is what keeps the three lists disjoint by construction, the same
//     way a delete removing the stored row keeps `held` and `deleted` apart.
//
// Sorted, hashes only — the wire shape discloses no filenames, dates or counts, exactly
// like the two lists it joins.
export function coveredDocumentHashes(profileId: number): string[] {
  return (
    db
      .prepare(
        `SELECT m.content_hash AS hash
           FROM document_coverage_markers m
          WHERE m.profile_id = ?
            AND EXISTS (
                  SELECT 1 FROM medical_documents d
                   WHERE d.profile_id = m.profile_id
                     AND d.clinical_key = m.clinical_key
                     AND ${heldDocumentPredicate("d")}
                )
            AND NOT EXISTS (
                  SELECT 1 FROM medical_documents h
                   WHERE h.profile_id = m.profile_id
                     AND h.content_hash = m.content_hash
                     AND ${heldDocumentPredicate("h")}
                )
          ORDER BY m.content_hash`
      )
      .all(profileId) as { hash: string }[]
  ).map((r) => r.hash);
}
