import { describe, expect, it } from "vitest";
import {
  MAX_AI_BYTES,
  MAX_HEALTH_BYTES,
  looksLikeHealthRecordUpload,
  preBufferSizeCap,
} from "../upload-gate";

// Pure unit coverage for the PRE-BUFFER upload size gate (issue #695). The gate
// decides how large an upload may be BEFORE its body is read into memory, using
// only the cheap filename/MIME signals available from the multipart headers.

describe("looksLikeHealthRecordUpload", () => {
  it("recognizes health-record filenames by extension", () => {
    for (const name of [
      "ccd.xml",
      "summary.CCDA",
      "record.cda",
      "MyChart-download.zip",
      "export.xdm",
      "bundle.json",
      "card.smart-health-card",
      "card.shc",
      "patient.fhir",
    ]) {
      expect(
        looksLikeHealthRecordUpload(name, "application/octet-stream"),
        name
      ).toBe(true);
    }
  });

  it("recognizes health-record uploads by declared MIME", () => {
    for (const mime of [
      "application/xml",
      "text/xml",
      "application/zip",
      "application/json",
      "application/fhir+json",
      "application/fhir+xml",
      "application/smart-health-card",
    ]) {
      expect(looksLikeHealthRecordUpload("download", mime), mime).toBe(true);
    }
  });

  it("ignores a charset parameter on the MIME", () => {
    expect(
      looksLikeHealthRecordUpload("download", "application/json; charset=utf-8")
    ).toBe(true);
  });

  it("does NOT flag AI-extracted document types", () => {
    expect(looksLikeHealthRecordUpload("scan.pdf", "application/pdf")).toBe(
      false
    );
    expect(looksLikeHealthRecordUpload("labs.csv", "text/csv")).toBe(false);
    expect(looksLikeHealthRecordUpload("photo.jpg", "image/jpeg")).toBe(false);
    expect(
      looksLikeHealthRecordUpload("sheet.xlsx", "application/octet-stream")
    ).toBe(false);
    expect(
      looksLikeHealthRecordUpload("notes.pdf", "application/octet-stream")
    ).toBe(false);
  });
});

describe("preBufferSizeCap", () => {
  it("defaults to the stricter AI cap for a non-health-signaled upload", () => {
    // The #695 fix: a non-health file is admitted only up to the 32MB AI ceiling,
    // so a 60MB PDF is rejected before it is ever fully buffered.
    expect(preBufferSizeCap("notes.pdf", "application/pdf")).toBe(MAX_AI_BYTES);
    expect(60 * 1024 * 1024).toBeGreaterThan(
      preBufferSizeCap("notes.pdf", "application/pdf")
    );
  });

  it("raises to the health cap only when a cheap signal suggests a health record", () => {
    expect(preBufferSizeCap("export.json", "application/fhir+json")).toBe(
      MAX_HEALTH_BYTES
    );
    expect(preBufferSizeCap("ccd.xml", "application/octet-stream")).toBe(
      MAX_HEALTH_BYTES
    );
    // A 60MB legitimate health record still fits under the raised ceiling.
    expect(60 * 1024 * 1024).toBeLessThan(
      preBufferSizeCap("export.xdm", "application/zip")
    );
  });

  it("keeps the health cap at or above the AI cap", () => {
    expect(MAX_HEALTH_BYTES).toBeGreaterThanOrEqual(MAX_AI_BYTES);
  });
});
