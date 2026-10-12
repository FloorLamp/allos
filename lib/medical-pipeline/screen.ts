import crypto from "node:crypto";
import { isSupportedFile } from "@/lib/medical-extract";
import {
  MAX_AI_BYTES,
  MAX_HEALTH_BYTES,
  preBufferSizeCap,
} from "@/lib/upload-gate";
import { sniffUploadType } from "@/lib/file-sniff";
import {
  detectHealthRecord,
  type HealthRecordKind,
} from "@/lib/health-record-parse";

// The checks every medical upload passes before anything is stored: the size gates, the
// type check and the content sniff, then the content hash. No DB, no fs. Shared by the
// ingest engine and the dry run, so "would this upload be refused" has one answer.
export type ScreenedUpload =
  | { ok: false; reason: string; size: number }
  | {
      ok: true;
      buffer: Buffer;
      healthKind: HealthRecordKind | null;
      // The byte-derived MIME — what the ingest persists, never the declared one.
      storedMime: string;
      contentHash: string;
    };

export async function screenUpload(file: File): Promise<ScreenedUpload> {
  const mime = file.type || "application/octet-stream";
  // Reject an oversized upload BEFORE buffering the whole file into memory —
  // file.size is known from the multipart headers, so we needn't read a huge body
  // just to reject it. The pre-buffer ceiling defaults to the stricter 32MB AI cap
  // and only rises to the 64MB health-record cap when a CHEAP pre-buffer signal
  // (filename extension / declared MIME) suggests a genuine deterministic health
  // record — so a large non-health file is rejected here WITHOUT ever being fully
  // buffered (issue #695), instead of admitting everything to 64MB and only
  // rejecting after the whole body was read into memory. The per-path post-buffer
  // cap below re-checks the true length once the content is actually sniffed.
  const preCap = preBufferSizeCap(file.name, mime);
  if (file.size > preCap) {
    return {
      ok: false,
      reason: `File too large (max ${Math.round(preCap / 1024 / 1024)}MB).`,
      size: file.size,
    };
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  // A MyChart CCD/XDM or SMART Health Card is imported deterministically (no AI);
  // everything else goes to the model, so it must be an AI-supported type.
  const healthKind = detectHealthRecord(buffer);
  if (!healthKind && !isSupportedFile(file.name, mime)) {
    return { ok: false, reason: "Unsupported file type.", size: file.size };
  }
  // Enforce the per-path size cap now that the byte length AND the kind are known:
  // an AI-extracted file is bound by the Anthropic request limit (it's inlined as
  // base64), a deterministic health record is not. Also backstops the pre-buffer
  // gate against a lying/absent file.size.
  const sizeCap = healthKind ? MAX_HEALTH_BYTES : MAX_AI_BYTES;
  if (buffer.length > sizeCap) {
    return {
      ok: false,
      reason: `File too large (max ${Math.round(sizeCap / 1024 / 1024)}MB).`,
      size: buffer.length,
    };
  }

  // Verify the CONTENT against its declared type/extension (issue #27). The
  // client-declared file.type is untrusted; derive a server-trusted MIME from the
  // magic bytes so the value we store (and later echo as Content-Type when serving)
  // reflects what the file actually is. A file whose bytes contradict its declared
  // type — a ".pdf" that isn't a PDF — is rejected here rather than stored under a
  // lie. Health records are exempt from rejection (detectHealthRecord/parse already
  // validated their structure); we still derive a trustworthy stored MIME for them.
  const typed = sniffUploadType({
    filename: file.name,
    declaredMime: mime,
    buffer,
    isHealthRecord: !!healthKind,
  });
  if (!typed.ok) {
    return { ok: false, reason: typed.reason, size: buffer.length };
  }
  return {
    ok: true,
    buffer,
    healthKind,
    // CSV/plain text carry no reliable magic, so this falls back to a benign
    // attachment-only type (text/csv, text/plain) that is never in the serve route's
    // INLINE_OK set.
    storedMime: typed.mime,
    // Identical bytes are the same document whatever the filename.
    contentHash: crypto.createHash("sha256").update(buffer).digest("hex"),
  };
}
