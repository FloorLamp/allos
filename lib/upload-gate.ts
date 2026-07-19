// Pure size-gate policy for the medical-document upload pipeline (issues #680,
// #695). No DB / fs / network imports — kept deliberately pure so the gate
// decision is unit-testable in lib/__tests__, and so the next.config transport-cap
// lockstep guard (lib/__tests__/upload-size-lockstep.test.ts) can import the byte
// ceilings without pulling in the DB layer. lib/medical-pipeline.ts re-exports
// MAX_AI_BYTES / MAX_HEALTH_BYTES so existing import paths are unchanged.

// AI-extracted uploads (PDF / image / spreadsheet) are inlined as base64 into the
// Anthropic Messages request, whose body Anthropic caps at 32MB — a HARD external
// limit for that path, not a tunable (raising it would need the Files API).
export const MAX_AI_BYTES = 32 * 1024 * 1024; // 32MB (Anthropic request cap)

// Health-record uploads (CCD/XDM/SHC/FHIR) are parsed DETERMINISTICALLY with no
// API call, so they aren't bound by the Anthropic limit — only by memory and the
// zip decompression caps (lib/zip.ts: 64MB/entry, 256MB total). A large
// multi-document MyChart XDM can exceed 32MB, so health records get their own
// higher cap. NB: the next.config transport caps
// (experimental.proxyClientMaxBodySize AND serverActions.bodySizeLimit) must both
// stay >= this + the multipart overhead margin, or Next truncates/rejects the
// request body before ingest ever runs — that lockstep is guarded by
// lib/__tests__/upload-size-lockstep.test.ts.
export const MAX_HEALTH_BYTES = 64 * 1024 * 1024; // 64MB

// Documented headroom between the app's own MAX_HEALTH_BYTES cap and the
// next.config transport caps: a multipart body is the file bytes PLUS
// boundary/field framing, so the transport limit sits one binary MB above the
// largest permitted upload. Exported for the lockstep guard.
export const MULTIPART_OVERHEAD_MARGIN = 1024 * 1024; // 1MiB

// Soft cap on how many medical documents one multi-file upload submit ingests
// (issue #1008). Multi-select / drag-drop lets a user hand over a whole stack at
// once; the extraction engine fans them out through its own concurrency limit +
// queue, but an unbounded batch could still swamp that queue, so the entry point
// ingests the first N and returns a friendly "add the rest in another batch" note
// for the remainder. A SOFT cap (skip the overflow, keep going) — not a hard wall
// that rejects the whole submit. Lives here with the other upload-gate policy so
// the client form and the server action share one number.
export const MEDICAL_UPLOAD_BATCH_CAP = 20;

// Cheap, PRE-BUFFER signals that an upload MIGHT be a deterministic health record
// (CCD/CDA XML, MyChart XDM zip, SMART Health Card, FHIR bundle) — derived only
// from the filename extension and the client-declared MIME type, both known from
// the multipart headers WITHOUT reading the body into memory. Deliberately
// permissive and untrusted: it decides ONLY which pre-buffer size ceiling to apply
// (issue #695), so a mislabeled file is caught downstream — detectHealthRecord
// re-verifies the actual magic bytes after buffering, and the per-path post-buffer
// cap re-checks the true length against MAX_AI_BYTES / MAX_HEALTH_BYTES.
const HEALTH_NAME_SUFFIXES = [
  ".xml",
  ".ccd",
  ".ccda",
  ".cda",
  ".xdm",
  ".zip",
  ".json",
  ".shc",
  ".smart-health-card",
  ".fhir",
];

const HEALTH_MIME_HINTS = new Set([
  "application/xml",
  "text/xml",
  "application/zip",
  "application/json",
  "application/fhir+json",
  "application/fhir+xml",
  "application/smart-health-card",
]);

export function looksLikeHealthRecordUpload(
  filename: string,
  declaredMime: string
): boolean {
  const name = filename.trim().toLowerCase();
  if (HEALTH_NAME_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  // Normalize a `type; charset=...` MIME down to the bare media type.
  const mime = declaredMime.trim().toLowerCase().split(";")[0].trim();
  if (HEALTH_MIME_HINTS.has(mime)) return true;
  // Any FHIR flavor (application/fhir+json, application/fhir+xml, and future
  // variants) counts as a health-record signal.
  if (mime.startsWith("application/fhir")) return true;
  return false;
}

// The size ceiling an upload is admitted to BEFORE its body is buffered into
// memory (issue #695). Default is the stricter 32MB AI cap; the higher 64MB
// health ceiling is only granted when a cheap pre-buffer signal (extension / MIME)
// suggests a genuine deterministic health record. This is the fix for the #695
// regression where every upload — including a non-health file rejected moments
// later — was admitted (and fully buffered) up to 64MB. A 60MB file with no
// health-record-suggesting extension/MIME is now rejected against the 32MB cap
// WITHOUT ever being read into memory.
export function preBufferSizeCap(
  filename: string,
  declaredMime: string
): number {
  return looksLikeHealthRecordUpload(filename, declaredMime)
    ? MAX_HEALTH_BYTES
    : MAX_AI_BYTES;
}
