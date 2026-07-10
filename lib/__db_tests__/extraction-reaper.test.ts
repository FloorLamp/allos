// DB INTEGRATION TIER — stuck-extraction lease reaper + WAL checkpoint (issue #135,
// items 4 and 6). Exercises the real schema (migration 004's processing_started_at
// column) and the actual UPDATE the hourly tick runs.
//
//   • reapStuckExtractions fails only rows in 'processing' whose lease has run past
//     the timeout; a fresh 'processing' row, a NULL-lease row, and non-processing
//     rows are all left alone.
//   • checkpointWal runs against the live handle without throwing.

import { describe, it, expect, beforeAll } from "vitest";
import { db, checkpointWal } from "@/lib/db";
import { reapStuckExtractions } from "@/lib/extraction-reaper";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Insert a medical_documents row with an explicit status + lease age (minutes ago,
// or null). Returns the row id.
function insertDoc(
  profileId: number,
  status: string,
  leaseMinutesAgo: number | null
): number {
  const startedAt =
    leaseMinutesAgo === null
      ? null
      : (
          db
            .prepare(`SELECT datetime('now', ?) AS t`)
            .get(`-${leaseMinutesAgo} minutes`) as { t: string }
        ).t;
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (filename, stored_path, mime_type, size_bytes, content_hash,
            extraction_status, processing_started_at, profile_id)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(
        "test.pdf",
        "data/uploads/medical/x/test.pdf",
        "application/pdf",
        1,
        null,
        status,
        startedAt,
        profileId
      ).lastInsertRowid
  );
}

function status(id: number): string {
  return (
    db
      .prepare(
        "SELECT extraction_status AS s FROM medical_documents WHERE id = ?"
      )
      .get(id) as { s: string }
  ).s;
}

let profileId: number;

beforeAll(() => {
  profileId = newProfile("REAPER-A");
});

describe("reapStuckExtractions (issue #135 item 4)", () => {
  it("fails a wedged 'processing' row past the lease, but spares fresh / null / terminal rows", () => {
    const wedged = insertDoc(profileId, "processing", 60); // 60m — past a 30m lease
    const fresh = insertDoc(profileId, "processing", 5); // 5m — within the lease
    const nullLease = insertDoc(profileId, "processing", null); // no lease stamp
    const doneRow = insertDoc(profileId, "done", 60); // terminal — not processing

    const reaped = reapStuckExtractions(30);
    expect(reaped).toBe(1);

    expect(status(wedged)).toBe("failed");
    expect(status(fresh)).toBe("processing");
    expect(status(nullLease)).toBe("processing");
    expect(status(doneRow)).toBe("done");

    // The reaped row carries a user-facing timeout message.
    const err = (
      db
        .prepare(
          "SELECT extraction_error AS e FROM medical_documents WHERE id = ?"
        )
        .get(wedged) as { e: string | null }
    ).e;
    expect(err).toMatch(/timed out/i);
  });

  it("is idempotent — a second pass reaps nothing new", () => {
    expect(reapStuckExtractions(30)).toBe(0);
  });

  it("respects the timeout argument (a shorter lease reaps the 5m row)", () => {
    const midAge = insertDoc(profileId, "processing", 5);
    // A 30m lease leaves this 5m row alone; a 1m lease sweeps it. (Assert on THIS
    // row's status, not a global count — earlier tests leave other rows behind.)
    expect(reapStuckExtractions(30)).toBe(0);
    expect(status(midAge)).toBe("processing");
    expect(reapStuckExtractions(1)).toBeGreaterThanOrEqual(1);
    expect(status(midAge)).toBe("failed");
  });
});

describe("checkpointWal (issue #135 item 6)", () => {
  it("runs against the live handle without throwing", () => {
    expect(() => checkpointWal()).not.toThrow();
  });
});
