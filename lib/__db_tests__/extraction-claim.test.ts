// DB INTEGRATION TIER (issue #324).
//
// claimDocumentForExtraction is the atomic claim BOTH the reprocess path and the
// duplicate-upload re-extraction path use to guarantee exactly one extraction runs
// on a docId. Before #324 the duplicate-upload path had NO claim, so two concurrent
// uploads of a 'failed' document could both flip it to 'processing' and both
// dispatch — double-charging the AI quota. This pins the claim's contract: the first
// caller wins (returns true, row now 'processing'), and any caller that meets an
// already-'processing' row loses (returns false, no second dispatch).
//
// Deterministic: :memory: only, no network.

import { describe, it, expect } from "vitest";
import { db, migrate } from "@/lib/db";
import { claimDocumentForExtraction } from "@/lib/extraction-claim";

process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "db-test-admin-pw";

// The db-test setup points the singleton at a fresh temp DB; migrate() builds the
// schema and bootstraps profile 1.
migrate(db);

function insertDoc(status: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (filename, stored_path, mime_type, size_bytes, content_hash, extraction_status, profile_id)
         VALUES ('report.pdf', 'data/uploads/medical/1/x.pdf', 'application/pdf', 10, ?, ?, 1)`
      )
      .run(status + "-hash", status).lastInsertRowid
  );
}

function statusOf(id: number): string {
  return (
    db
      .prepare(
        "SELECT extraction_status AS s FROM medical_documents WHERE id = ?"
      )
      .get(id) as { s: string }
  ).s;
}

describe("claimDocumentForExtraction — atomic single-winner claim", () => {
  it("claims a 'failed' row: flips it to 'processing' and returns true", () => {
    const id = insertDoc("failed");
    expect(claimDocumentForExtraction(1, id)).toBe(true);
    expect(statusOf(id)).toBe("processing");
  });

  it("refuses a row already 'processing': returns false, leaves it untouched", () => {
    const id = insertDoc("failed");
    expect(claimDocumentForExtraction(1, id)).toBe(true); // first caller wins
    expect(claimDocumentForExtraction(1, id)).toBe(false); // concurrent loser
    expect(statusOf(id)).toBe("processing");
  });

  it("clears a prior extraction_error and stamps processing_started_at on claim", () => {
    const id = insertDoc("failed");
    db.prepare(
      "UPDATE medical_documents SET extraction_error = 'boom', processing_started_at = NULL WHERE id = ?"
    ).run(id);
    expect(claimDocumentForExtraction(1, id)).toBe(true);
    const row = db
      .prepare(
        "SELECT extraction_error AS err, processing_started_at AS started FROM medical_documents WHERE id = ?"
      )
      .get(id) as { err: string | null; started: string | null };
    expect(row.err).toBeNull();
    expect(row.started).not.toBeNull();
  });

  it("is scoped by profile_id — a foreign profile can't claim the row", () => {
    const id = insertDoc("failed");
    db.prepare("INSERT INTO profiles (id, name) VALUES (2, 'Other')").run();
    expect(claimDocumentForExtraction(2, id)).toBe(false);
    expect(statusOf(id)).toBe("failed"); // untouched
  });
});
