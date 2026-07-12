// DB INTEGRATION TIER — the boot-time interrupted-work reset is age-gated (issue #461).
//
// bootTasks runs in EVERY process, including the hourly notify tick (scripts/notify.ts
// imports lib/db => createDb => bootTasks at the top of every hour). The pre-#461 reset
// unconditionally flipped every 'processing'/'committing' row to 'failed', so a fresh
// in-flight extraction/import the web process started seconds earlier was falsely failed
// by the tick's boot — a false failure toast, a double-charged AI retry, or the alarming
// "data may already have been imported" on a commit that was actually succeeding.
//
// resetInterruptedWork now age-gates on the extraction lease window, so it reaps ONLY
// genuinely-stranded rows (past the lease) in any process. These tests drive it with a
// controlled window against the real schema and pin: fresh rows survive, stale rows reap.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { resetInterruptedWork } from "@/lib/migrations/boot-tasks";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// medical_documents row at an explicit status + lease age (minutes ago, or null).
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

// import_jobs row at an explicit status, with updated_at aged `minutesAgo` back.
function insertJob(
  profileId: number,
  status: string,
  updatedMinutesAgo: number
): number {
  const ts = (
    db
      .prepare(`SELECT datetime('now', ?) AS t`)
      .get(`-${updatedMinutesAgo} minutes`) as { t: string }
  ).t;
  return Number(
    db
      .prepare(
        `INSERT INTO import_jobs (profile_id, type, status, updated_at)
         VALUES (?, 'biomarkers', ?, ?)`
      )
      .run(profileId, status, ts).lastInsertRowid
  );
}

function docStatus(id: number): string {
  return (
    db
      .prepare(
        "SELECT extraction_status AS s FROM medical_documents WHERE id = ?"
      )
      .get(id) as { s: string }
  ).s;
}

function jobStatus(id: number): string {
  return (
    db.prepare("SELECT status AS s FROM import_jobs WHERE id = ?").get(id) as {
      s: string;
    }
  ).s;
}

let profileId: number;

beforeEach(() => {
  profileId = newProfile("BOOT-RESET");
});

describe("resetInterruptedWork age gate (issue #461)", () => {
  it("spares a FRESH in-flight extraction but reaps a stranded one", () => {
    const fresh = insertDoc(profileId, "processing", 0); // started just now
    const stranded = insertDoc(profileId, "processing", 60); // 60m ago — abandoned
    const done = insertDoc(profileId, "done", 60); // terminal — untouched

    resetInterruptedWork(db, 30);

    expect(docStatus(fresh)).toBe("processing"); // the #461 regression guard
    expect(docStatus(stranded)).toBe("failed");
    expect(docStatus(done)).toBe("done");
  });

  it("spares a fresh import job (processing + committing) but reaps stranded ones", () => {
    const freshProcessing = insertJob(profileId, "processing", 0);
    const freshCommitting = insertJob(profileId, "committing", 0);
    const strandedProcessing = insertJob(profileId, "processing", 60);
    const strandedCommitting = insertJob(profileId, "committing", 60);

    resetInterruptedWork(db, 30);

    expect(jobStatus(freshProcessing)).toBe("processing");
    expect(jobStatus(freshCommitting)).toBe("committing");
    expect(jobStatus(strandedProcessing)).toBe("failed");
    expect(jobStatus(strandedCommitting)).toBe("failed");
  });

  it("is idempotent — a second pass over already-reaped rows changes nothing", () => {
    const stranded = insertDoc(profileId, "processing", 60);
    const job = insertJob(profileId, "committing", 60);
    resetInterruptedWork(db, 30);
    expect(docStatus(stranded)).toBe("failed");
    expect(jobStatus(job)).toBe("failed");
    // Second pass: the rows are terminal now, so nothing flips again.
    resetInterruptedWork(db, 30);
    expect(docStatus(stranded)).toBe("failed");
    expect(jobStatus(job)).toBe("failed");
  });
});
