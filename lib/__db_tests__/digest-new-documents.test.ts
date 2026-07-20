// DB INTEGRATION TIER — the morning digest's "new documents" window (issue
// #1022). "New" means the extraction COMPLETED since the digest cursor, not
// uploaded since: the old `uploaded_at > cursor AND extraction_status = 'done'`
// read permanently missed any document whose extraction finished after the
// cursor passed its upload time. This suite drives the REAL 'done' transition
// (persistDocumentImport — the one finalize UPDATE that stamps
// `extraction_completed_at`) and pins both failure modes from the issue:
//   1. the RACE — uploaded just before a digest, still 'processing' when it
//      sent, completing minutes later → announced the NEXT morning, once;
//   2. the REPROCESS — uploaded days ago, initially 'failed', reprocessed to
//      'done' long after its upload time fell behind the cursor → announced the
//      morning after the reprocess succeeds, once.
// Plus the migration-075 backfill semantics (uploaded_at, best-effort, keeps
// pre-existing history OUT of the next window, never overwrites a real stamp).
//
// Cursors and upload times are EXPLICIT datetime('now', modifier) fixtures
// (issue #1048 — no real-now recency windows beyond the unavoidable "completed
// now" stamp the writer itself makes, which every window here brackets).
// All values synthetic — fictional filenames/sources, no real PHI.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { persistDocumentImport } from "@/lib/import-persist";
import type { PersistInput } from "@/lib/import-shape";
import { setProfileSetting } from "@/lib/settings";
import { up as migration075Up } from "@/lib/migrations/versions/075-extraction-completed-at";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A datetime('now') UTC string shifted by a SQLite modifier — the same format
// the digest cursor and uploaded_at use, so string comparison is exact.
function at(modifier: string): string {
  return (
    db.prepare("SELECT datetime('now', ?) AS t").get(modifier) as { t: string }
  ).t;
}

// A medical_documents row with an explicit uploaded_at and status.
function newDocument(
  profileId: number,
  filename: string,
  status: string,
  uploadedAt: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, uploaded_at)
         VALUES (?, ?, '', ?, ?)`
      )
      .run(profileId, filename, status, uploadedAt).lastInsertRowid
  );
}

// The smallest valid PersistInput: no clinical rows, just the document finalize.
// `source` becomes the digest label (source || doc_type || filename).
function minimalInput(source: string): PersistInput {
  return {
    records: [],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    appointments: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source,
      documentDate: "2020-05-01",
      patientName: "Test Patient",
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function digestDocs(profileId: number, name: string): string[] {
  return gatherDigestInput(profileId, name).newDocumentLabels;
}

describe("digest new-documents window keys on extraction completion (#1022)", () => {
  it("the race: uploaded before the cursor, completed after it → announced the next morning, exactly once", () => {
    const p = newProfile("Digest Race");
    // Uploaded 8:50-style: BEFORE the last digest cursor…
    const doc = newDocument(p, "race-labs.pdf", "processing", at("-2 hours"));
    // …which advanced at 9:00 while the doc was still 'processing'.
    setProfileSetting(p, "notify_digest_last_at", at("-1 hour"));

    // Not yet done → not announced (and never mis-announced mid-extraction).
    expect(digestDocs(p, "Digest Race")).toEqual([]);

    // Extraction completes now, through the real 'done' finalize.
    persistDocumentImport(p, doc, minimalInput("Race Clinic CCD"));
    const row = db
      .prepare(
        "SELECT extraction_completed_at, uploaded_at FROM medical_documents WHERE id = ?"
      )
      .get(doc) as { extraction_completed_at: string; uploaded_at: string };
    // The stamp is the completion moment — strictly after the upload time the
    // old window keyed on (which sits behind the cursor and would never match).
    expect(row.extraction_completed_at > row.uploaded_at).toBe(true);

    // Tomorrow's digest (cursor still at the pre-completion 9:00) lists it.
    expect(digestDocs(p, "Digest Race")).toEqual(["Race Clinic CCD"]);

    // A delivered digest advances the cursor past the completion → exactly once.
    setProfileSetting(p, "notify_digest_last_at", at("+1 minute"));
    expect(digestDocs(p, "Digest Race")).toEqual([]);
  });

  it("the reprocess: failed at upload days ago, reprocessed to done today → announced after the reprocess, exactly once", () => {
    const p = newProfile("Digest Reprocess");
    // Uploaded 10 days ago, extraction failed then; every digest since has
    // advanced the cursor far past its upload time.
    const doc = newDocument(p, "old-visit.pdf", "failed", at("-10 days"));
    setProfileSetting(p, "notify_digest_last_at", at("-1 day"));
    expect(digestDocs(p, "Digest Reprocess")).toEqual([]);

    // The reprocess succeeds today, through the same real finalize.
    persistDocumentImport(p, doc, minimalInput("Reprocessed Visit Summary"));
    expect(digestDocs(p, "Digest Reprocess")).toEqual([
      "Reprocessed Visit Summary",
    ]);

    // Cursor advances on the next delivered digest → never announced again.
    setProfileSetting(p, "notify_digest_last_at", at("+1 minute"));
    expect(digestDocs(p, "Digest Reprocess")).toEqual([]);
  });

  it("migration 075 backfill: existing done rows get uploaded_at (staying out of the window); a real stamp is never overwritten", () => {
    const p = newProfile("Digest Backfill");
    // A pre-migration-shaped 'done' row: completed stamp missing.
    const legacy = newDocument(p, "legacy-panel.pdf", "done", at("-5 days"));
    db.prepare(
      "UPDATE medical_documents SET extraction_completed_at = NULL WHERE id = ?"
    ).run(legacy);
    // And a post-migration row whose real completion stamp must survive replay.
    const fresh = newDocument(p, "fresh-panel.pdf", "done", at("-3 days"));
    const realStamp = at("-2 days");
    db.prepare(
      "UPDATE medical_documents SET extraction_completed_at = ? WHERE id = ?"
    ).run(realStamp, fresh);

    migration075Up(db);

    const stamps = db
      .prepare(
        "SELECT id, uploaded_at, extraction_completed_at FROM medical_documents WHERE profile_id = ? ORDER BY id"
      )
      .all(p) as {
      id: number;
      uploaded_at: string;
      extraction_completed_at: string;
    }[];
    // Backfill = uploaded_at (best-effort ordering)…
    expect(stamps[0].extraction_completed_at).toBe(stamps[0].uploaded_at);
    // …and the replay never clobbers a genuine completion stamp.
    expect(stamps[1].extraction_completed_at).toBe(realStamp);

    // The backfilled history stays OUT of a live digest window: its stamp
    // (5 days ago) is behind the cursor, so nothing is dumped as "new".
    setProfileSetting(p, "notify_digest_last_at", at("-1 day"));
    expect(digestDocs(p, "Digest Backfill")).toEqual([]);
  });
});
