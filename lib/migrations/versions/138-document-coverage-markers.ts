import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 138 (issue #1828): the COVERAGE MARKER — "an acquirer offered these bytes and
// allos refused them, because it already holds every clinical entry they carry."
//
// ── THE LOOP THIS ENDS ───────────────────────────────────────────────────────
//
// #1776's inventory answers two lists and documents one rule: send exactly the hashes in
// NEITHER. That rule has no answer for a third outcome the upload path can return. A
// `duplicate` refusal stores NOTHING (#1781: no medical_documents row, no content hash),
// so the refused hash is in neither `held` (nothing was stored) nor `deleted` (nobody
// deleted anything) — and the rule therefore tells the client to send it again, forever.
// Observed live: 1.7 MB re-uploaded and re-parsed on every run, refused identically each
// time, never converging.
//
// #1786 made that a NORMAL state rather than an edge case: one person reachable through
// two portal logins, both labels bound to one profile, is a configuration the identity
// model explicitly supports — so the second export is permanently redundant BY DESIGN.
//
// ── WHY IT NEEDS A TABLE AT ALL ──────────────────────────────────────────────
//
// The third list cannot be computed from nothing. At inventory time the server is asked
// about hashes it never stored: no bytes, no row, no hash → clinical-key mapping. The
// duplicate verdict exists only DURING an upload, when the offered file is in hand and its
// #1780 clinical key can be computed. So the third list requires persisting a memory of
// the refusal — which is exactly what this table is, and all it is.
//
// ── WHY NOT `import_tombstones` ──────────────────────────────────────────────
//
// #1777's document tombstone shares that table, and reusing it here would conflate a
// PERSON'S decision with the ENGINE'S — with genuinely different rules in both directions.
// A human re-upload CLEARS a tombstone (manual wins), while a human re-upload of a covered
// file should simply get the duplicate verdict again; and tombstones are deliberately
// never swept, while a coverage marker's validity is recomputed on every read. Different
// rules, different table.
//
// ── EVIDENCE STORED, VERDICT RECOMPUTED ──────────────────────────────────────
//
// The row records only what was true at the moment of refusal: WHICH bytes were offered
// and WHICH clinical key covered them. Whether that coverage still holds is asked at READ
// time, against the documents the profile holds right now — the same probe the ingest
// already runs (#1780: both sides derive the key identically by construction). Delete the
// covering document, reassign it away, or reprocess it into a different entry set, and the
// hash silently leaves the `covered` list and the client re-offers. No lifecycle
// management, no invalidation hooks, nothing to keep consistent — the same
// storage-of-evidence / verdict-at-read shape `reconciledFlag` recomputation uses.
//
// ── THE GRAIN, AND WHY THE TABLE IS BOUNDED IN PRACTICE ──────────────────────
//
// UNIQUE(profile_id, content_hash): one row per (person, offered file), refreshed on
// re-offer. The loop the issue reports — an acquirer re-offering the SAME bytes every run
// — therefore converges to exactly one row and stops transferring anything. An acquirer
// that re-downloads a freshly regenerated container each run mints a new hash each run and
// so a new marker each run; that case is beyond what any hash-keyed memory can collapse
// (it never offers the same hash twice), and each row is a few dozen bytes with no file
// and no children behind it.
//
// PROFILE-OWNED, so it joins lib/owned-tables.ts and is cleared with the profile. It is
// NOT written by document import and holds no health data: it is a record of an offer that
// was refused, which is why it is out of the portable export and untouched by document
// delete, reassignment, and extracted-count accounting.
//
// House rules (CLAUDE.md): one new table, no rebuild, so there is nothing to null
// beforehand. Self-contained — imports nothing from lib/ — so a replay is decided purely
// by the DB catalog. Determinism (spec): reads only the database. No `datetime('now')`
// default: `refused_at` is bound by the writer through the sqlNow clock seam (#1534).

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS document_coverage_markers (
         id           INTEGER PRIMARY KEY AUTOINCREMENT,
         profile_id   INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
         -- The bytes an acquirer offered and allos refused. Not a foreign key to
         -- anything: the whole point is that NO row was stored for these bytes.
         content_hash TEXT NOT NULL,
         -- The clinical identity (migration 136) that was already covered. The read
         -- re-asks whether this profile still holds a document carrying it; when it does
         -- not, the marker stops answering and the client re-offers.
         clinical_key TEXT NOT NULL,
         -- When the refusal last happened. An audit stamp, refreshed on re-offer.
         refused_at   TEXT NOT NULL,
         -- One marker per (person, offered file). The upsert grain, and what keeps a
         -- daily re-offer of the same bytes from growing the table.
         UNIQUE (profile_id, content_hash)
       )`
    );
    // The inventory read walks a profile's markers and probes each key, so the index
    // leads with profile_id — the same shape idx_meddoc_clinical_key gives the ingest's
    // side of the identical question.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_doc_coverage_key
         ON document_coverage_markers(profile_id, clinical_key)`
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 138,
  name: "138-document-coverage-markers",
  up,
};
