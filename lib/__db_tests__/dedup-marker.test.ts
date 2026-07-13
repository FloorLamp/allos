// DB INTEGRATION TIER — content-hash dedup target selection (issue #612).
//
// insertDuplicateDoc persists a file-less 'skipped' marker row carrying the content
// hash. Before the fix, findExisting matched ANY row with the hash, so after the
// original document was deleted the surviving marker still "won" — and because it has
// no stored file, the advertised "reprocess that document" path also failed, leaving
// the file permanently un-re-uploadable. findDedupTarget now excludes a file-less
// terminal marker (so a re-upload proceeds fresh AND a pre-existing stranded marker
// heals) while still matching an in-flight placeholder (so concurrent identical
// uploads still dedup to one document).
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { findDedupTarget } from "@/lib/medical-pipeline";
import { db } from "@/lib/db";

const HASH = "a".repeat(64);

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function insertDoc(
  profileId: number,
  opts: { status: string; storedPath: string; hash?: string; filename?: string }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, content_hash, extraction_status)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        opts.filename ?? "A.pdf",
        opts.storedPath,
        opts.hash ?? HASH,
        opts.status
      ).lastInsertRowid
  );
}

describe("content-hash dedup target selection (#612)", () => {
  it("re-upload proceeds fresh once the original is deleted and only a file-less marker remains", () => {
    const profileId = newProfile("DEDUP-MARKER");
    // 1. Original upload (imported, has a stored file) + an accidental re-upload that
    //    became a file-less 'skipped' duplicate marker carrying the same hash.
    const original = insertDoc(profileId, {
      status: "done",
      storedPath: "data/uploads/medical/1/A.pdf",
    });
    insertDoc(profileId, { status: "skipped", storedPath: "" });

    // While the original survives, it's the dedup target (a genuine re-upload is a dup).
    expect(findDedupTarget(profileId, HASH)?.id).toBe(original);

    // 2. Delete the original — only the file-less 'skipped' marker is left.
    db.prepare("DELETE FROM medical_documents WHERE id = ?").run(original);

    // 3. The marker no longer matches, so a re-upload proceeds as a fresh document
    //    instead of pointing at an un-reprocessable marker.
    expect(findDedupTarget(profileId, HASH)).toBeUndefined();
  });

  it("still matches an in-flight file-less placeholder (concurrent-upload dedup preserved)", () => {
    const profileId = newProfile("DEDUP-INFLIGHT");
    // A concurrent identical upload reserves a 'processing' placeholder with no file yet.
    const placeholder = insertDoc(profileId, {
      status: "processing",
      storedPath: "",
    });
    expect(findDedupTarget(profileId, HASH)?.id).toBe(placeholder);
  });

  it("prefers the file-bearing original over a co-existing file-less marker", () => {
    const profileId = newProfile("DEDUP-PREFER");
    insertDoc(profileId, { status: "skipped", storedPath: "" });
    const original = insertDoc(profileId, {
      status: "done",
      storedPath: "data/uploads/medical/1/A.pdf",
    });
    expect(findDedupTarget(profileId, HASH)?.id).toBe(original);
  });

  it("is profile-scoped (never matches another profile's document)", () => {
    const a = newProfile("DEDUP-A");
    const b = newProfile("DEDUP-B");
    insertDoc(a, {
      status: "done",
      storedPath: "data/uploads/medical/a/A.pdf",
    });
    expect(findDedupTarget(b, HASH)).toBeUndefined();
  });
});
