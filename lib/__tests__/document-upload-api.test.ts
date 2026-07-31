import { describe, expect, it } from "vitest";
import {
  anyUploadFailed,
  classifyUploadOutcome,
  type LandedDocumentRow,
} from "../document-upload-api";

// PURE TIER (issue #1735). The endpoint's two decisions, away from a request.
//
// The outcome mapping is the interesting one: the ingest engine lands a row on EVERY
// path, but its vocabulary is the EXTRACTION lifecycle, which is not the same question
// as "did my upload land". Getting this wrong in either direction is a real bug — a
// duplicate reported as stored makes a re-run look like it doubled the record, and a
// stored document reported as failed sends someone hunting for a file that is fine.

const row = (over: Partial<LandedDocumentRow> = {}): LandedDocumentRow => ({
  docId: 10,
  maxIdBefore: 9,
  status: "processing",
  storedPath: "medical/3/10-labs.pdf",
  error: null,
  ...over,
});

describe("classifyUploadOutcome", () => {
  it("a new row with a file is stored", () => {
    expect(classifyUploadOutcome(row())).toEqual({
      outcome: "stored",
      reason: null,
    });
  });

  it("a new file-less 'skipped' marker is a duplicate, carrying the engine's reason", () => {
    expect(
      classifyUploadOutcome(
        row({
          status: "skipped",
          storedPath: "",
          error: "Duplicate upload — this file was already uploaded. Skipped.",
        })
      )
    ).toEqual({
      outcome: "duplicate",
      reason: "Duplicate upload — this file was already uploaded. Skipped.",
    });
  });

  it("a new file-less 'failed' marker is a failure, carrying the reason", () => {
    expect(
      classifyUploadOutcome(
        row({
          status: "failed",
          storedPath: "",
          error: "File too large (max 32MB).",
        })
      )
    ).toEqual({ outcome: "failed", reason: "File too large (max 32MB)." });
  });

  it("treats a NULL stored_path the same as an empty one", () => {
    expect(
      classifyUploadOutcome(
        row({
          status: "failed",
          storedPath: null,
          error: "Unsupported file type.",
        })
      ).outcome
    ).toBe("failed");
  });

  it("a PRE-EXISTING row is a duplicate even though it looks freshly stored", () => {
    // The engine's reprocess path: identical bytes whose original had failed
    // extraction and still has its file, so it re-runs that row in place instead of
    // storing a second copy. Nothing on the row distinguishes it — only the id does.
    expect(
      classifyUploadOutcome(
        row({ docId: 4, maxIdBefore: 9, status: "processing" })
      ).outcome
    ).toBe("duplicate");
    // The boundary: the row that IS the previous maximum is pre-existing too.
    expect(
      classifyUploadOutcome(row({ docId: 9, maxIdBefore: 9 })).outcome
    ).toBe("duplicate");
  });

  it("a 'skipped' row that DOES have a file is stored, not a duplicate", () => {
    // The AI queue shed this extraction; the document itself is in the record, and
    // reprocessing is a Review concern rather than an upload failure.
    expect(
      classifyUploadOutcome(
        row({ status: "skipped", error: "The extraction queue is full." })
      ).outcome
    ).toBe("stored");
  });

  it("a stored row whose extraction failed later is still stored", () => {
    expect(classifyUploadOutcome(row({ status: "failed" })).outcome).toBe(
      "stored"
    );
  });

  it("never invents a reason the engine did not write", () => {
    expect(
      classifyUploadOutcome(
        row({ status: "failed", storedPath: "", error: null })
      ).reason
    ).toBeNull();
  });
});

describe("anyUploadFailed", () => {
  it("is true only when something failed", () => {
    expect(anyUploadFailed(["stored", "duplicate"])).toBe(false);
    expect(anyUploadFailed(["stored", "failed"])).toBe(true);
    expect(anyUploadFailed([])).toBe(false);
  });
});
