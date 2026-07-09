// Pure magic-byte sniffing for uploaded files (issue #27). No DB / network — this
// module is unit-tested over synthetic Buffer prefixes (lib/__tests__/file-sniff.test.ts).
//
// The medical upload path takes `file.type` from the client verbatim and echoes
// the stored mime_type back as the Content-Type when serving a file. Trusting the
// client-declared MIME lets a caller mislabel a file (a ".pdf" that is really
// something else, or an octet-stream that claims to be an inline-served image).
// These helpers derive a SERVER-trusted MIME from the actual bytes so the stored
// (and later served) type reflects the content, and flag a file whose contents
// contradict its declared type/extension so the upload action can reject it.
//
// Prior art: lib/profile-photo.ts already derives a photo's on-disk extension from
// the validated MIME rather than the client filename.

// A canonical MIME we can positively identify from leading magic bytes.
export type SniffedMime =
  | "application/pdf"
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "image/tiff"
  | "image/heic"
  | "image/heif"
  | "application/zip"
  | "application/xml"
  | "application/json";

// Coarse content family used to compare a file's declared intent (from its
// extension / declared MIME) against what the bytes actually are.
type Family = "pdf" | "image" | "zip" | "xml" | "json" | "text" | "unknown";

// Image extensions we can reliably detect from magic bytes. A file named with one
// of these whose bytes carry no recognizable magic is a positive contradiction
// (see sniffUploadType). Deliberately excludes formats with no/weak magic (e.g.
// .bmp) so we never false-reject a genuine-but-unsniffed image.
const MAGIC_IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "tiff",
  "tif",
  "heic",
  "heif",
]);

const asciiAt = (buf: Buffer, offset: number, len: number): string =>
  buf.length >= offset + len
    ? buf.toString("latin1", offset, offset + len)
    : "";

const startsWithBytes = (buf: Buffer, bytes: number[]): boolean => {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
};

// HEIF-family ftyp brands → the MIME we report. Other ftyp brands (isom/mp4*/M4A)
// are video/audio containers, not supported image uploads, so they sniff to null.
const HEIF_BRANDS: Record<string, "image/heic" | "image/heif"> = {
  heic: "image/heic",
  heix: "image/heic",
  heim: "image/heic",
  heis: "image/heic",
  hevc: "image/heic",
  hevx: "image/heic",
  mif1: "image/heif",
  msf1: "image/heif",
  heif: "image/heif",
};

// Skip a leading UTF-8 BOM and any whitespace, returning the index of the first
// meaningful byte (used for the text-structured formats: XML and JSON).
function firstMeaningfulIndex(buf: Buffer): number {
  let i = 0;
  if (
    buf.length >= 3 &&
    buf[0] === 0xef &&
    buf[1] === 0xbb &&
    buf[2] === 0xbf
  ) {
    i = 3; // UTF-8 BOM
  }
  while (i < buf.length) {
    const c = buf[i];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
    else break;
  }
  return i;
}

// Detect a file's content type from its leading magic bytes. Returns a canonical
// MIME for a recognized binary/structured format, or null for text-ish content
// (CSV, plain text, a bare SMART Health Card JWS) and anything unrecognized.
export function sniffMime(buffer: Buffer): SniffedMime | null {
  if (buffer.length === 0) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  // JPEG: FF D8 FF
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (asciiAt(buffer, 0, 6) === "GIF87a" || asciiAt(buffer, 0, 6) === "GIF89a")
    return "image/gif";
  // WebP: "RIFF" .... "WEBP"
  if (asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP")
    return "image/webp";
  // TIFF: "II*\0" (little-endian) or "MM\0*" (big-endian)
  if (
    startsWithBytes(buffer, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWithBytes(buffer, [0x4d, 0x4d, 0x00, 0x2a])
  )
    return "image/tiff";
  // HEIC/HEIF: an ISO-BMFF file whose box at offset 4 is "ftyp" and whose major
  // brand (offset 8) is a known HEIF brand. The box-length prefix sits at bytes
  // 0..3, so the "ftyp" marker is at offset 4 and the brand at offset 8.
  if (asciiAt(buffer, 4, 4) === "ftyp") {
    const brand = asciiAt(buffer, 8, 4).toLowerCase();
    if (brand in HEIF_BRANDS) return HEIF_BRANDS[brand];
  }
  // ZIP (also .xlsx and IHE XDM health-record archives): "PK\x03\x04" (local
  // file), "PK\x05\x06" (empty archive), or "PK\x07\x08" (spanned).
  if (
    startsWithBytes(buffer, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWithBytes(buffer, [0x50, 0x4b, 0x07, 0x08])
  )
    return "application/zip";
  // PDF: "%PDF-" at or near the start. The spec allows a small amount of leading
  // bytes, so scan the first 1KB rather than requiring offset 0.
  if (buffer.subarray(0, 1024).indexOf("%PDF-", 0, "latin1") !== -1)
    return "application/pdf";

  // Text-structured formats: skip a BOM + leading whitespace, then match a marker.
  const start = firstMeaningfulIndex(buffer);
  if (start < buffer.length) {
    const head = buffer.toString(
      "latin1",
      start,
      Math.min(start + 64, buffer.length)
    );
    // XML / C-CDA clinical document (BOM-tolerant): "<?xml" or "<ClinicalDocument".
    if (/^<\?xml/i.test(head) || /^<ClinicalDocument[\s>]/i.test(head))
      return "application/xml";
    // JSON (FHIR bundles, SMART Health Card wrappers): a leading '{' or '['.
    const c = buffer[start];
    if (c === 0x7b || c === 0x5b) return "application/json";
  }

  return null;
}

function familyOfMime(mime: SniffedMime): Family {
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/zip") return "zip";
  if (mime === "application/xml") return "xml";
  if (mime === "application/json") return "json";
  return "image"; // all remaining SniffedMime values are image/*
}

function extName(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return m ? m[1].toLowerCase() : "";
}

// The content families a file's NAME + DECLARED MIME claim it to be. A file can
// legitimately declare more than one (e.g. an image/png MIME on a ".pdf" name);
// the bytes are the tie-breaker in sniffUploadType.
function declaredFamilies(filename: string, declaredMime: string): Set<Family> {
  const s = new Set<Family>();
  const e = extName(filename);
  if (e === "pdf") s.add("pdf");
  if (MAGIC_IMAGE_EXTS.has(e) || e === "bmp") s.add("image");
  if (e === "xlsx" || e === "zip" || e === "xdm") s.add("zip");
  if (e === "xml" || e === "ccd" || e === "ccda" || e === "cda") s.add("xml");
  if (e === "json" || e === "fhir") s.add("json");
  if (e === "csv" || e === "txt" || e === "text") s.add("text");

  const m = (declaredMime || "").toLowerCase();
  if (m === "application/pdf") s.add("pdf");
  if (m.startsWith("image/")) s.add("image");
  if (
    m === "application/zip" ||
    m === "application/vnd.ms-excel" ||
    m.includes("officedocument.spreadsheet")
  )
    s.add("zip");
  if (m === "application/xml" || m === "text/xml") s.add("xml");
  if (m === "application/json") s.add("json");
  if (m === "text/csv" || m.startsWith("text/")) s.add("text");
  return s;
}

// A benign, attachment-only MIME for a text-ish upload that carries no reliable
// magic (CSV / plain text). Never returns a value in the serve route's INLINE_OK
// set, so an unverifiable file can't be talked into inline rendering.
function textFallbackMime(filename: string): string {
  const e = extName(filename);
  if (e === "csv") return "text/csv";
  if (e === "txt" || e === "text") return "text/plain";
  return "application/octet-stream";
}

function humanFamily(f: Family): string {
  switch (f) {
    case "pdf":
      return "a PDF";
    case "image":
      return "an image";
    case "zip":
      return "a Zip/Office archive";
    case "xml":
      return "an XML document";
    case "json":
      return "a JSON document";
    default:
      return "that type";
  }
}

function humanSniff(mime: SniffedMime | null): string {
  if (!mime) return "not a recognized document, image, or archive";
  const map: Record<SniffedMime, string> = {
    "application/pdf": "a PDF",
    "image/png": "a PNG image",
    "image/jpeg": "a JPEG image",
    "image/gif": "a GIF image",
    "image/webp": "a WebP image",
    "image/tiff": "a TIFF image",
    "image/heic": "a HEIC image",
    "image/heif": "a HEIF image",
    "application/zip": "a Zip archive",
    "application/xml": "an XML document",
    "application/json": "a JSON document",
  };
  return map[mime];
}

export type UploadTypeDecision =
  // The MIME to store is byte-derived when the content is recognized; a benign
  // attachment-only type otherwise.
  | { ok: true; mime: string }
  // A friendly, per-file rejection reason for a content/type contradiction.
  | { ok: false; reason: string };

// Decide the trusted stored MIME for an upload, and whether the file's contents
// contradict its declared type/extension badly enough to reject (issue #27).
//
//  - Health records (already byte-validated by detectHealthRecord/parse) are
//    never rejected here; we only derive a trustworthy, attachment-only MIME.
//  - When the bytes are recognized and agree with the declared family (or the
//    declaration is ambiguous), we store the BYTE-DERIVED MIME — so an image is
//    stored as its true image/* type and a PDF as application/pdf.
//  - When the bytes are recognized but contradict the declared family (a ".pdf"
//    whose bytes are a PNG), we reject.
//  - When the bytes carry no magic but the name/MIME claim a format that always
//    has magic (PDF, Zip/xlsx, or a magic-bearing image extension), we reject —
//    a genuine file of that type would have been recognized.
//  - Otherwise (CSV / plain text / an unsniffable-but-plausible file) we accept
//    and fall back to a benign attachment-only MIME, never an inline-served type.
export function sniffUploadType(opts: {
  filename: string;
  declaredMime: string;
  buffer: Buffer;
  isHealthRecord?: boolean;
}): UploadTypeDecision {
  const sniffed = sniffMime(opts.buffer);

  if (opts.isHealthRecord) {
    // CCD/XDM/SHC/FHIR — the parser already validated the structure. Store a
    // byte-derived, attachment-only MIME (all sniffed health-record types fall
    // outside the serve route's INLINE_OK set).
    return { ok: true, mime: sniffed ?? "application/octet-stream" };
  }

  const declared = declaredFamilies(opts.filename, opts.declaredMime);

  if (sniffed) {
    const sniffFam = familyOfMime(sniffed);
    // Compatible when the declaration is ambiguous/unknown, or names the family we
    // actually found. Otherwise it's a genuine contradiction → reject.
    if (declared.size === 0 || declared.has(sniffFam)) {
      return { ok: true, mime: sniffed };
    }
    const claimed = [...declared][0];
    return {
      ok: false,
      reason: `This file is named like ${humanFamily(
        claimed
      )} but its contents are ${humanSniff(
        sniffed
      )}. Re-export or rename the file and try again.`,
    };
  }

  // No recognizable magic. A file that claims a format which ALWAYS carries magic
  // (PDF, Zip/xlsx, or a magic-bearing image extension) but has none is corrupt or
  // mislabeled → reject.
  const e = extName(opts.filename);
  if (declared.has("pdf") || declared.has("zip") || MAGIC_IMAGE_EXTS.has(e)) {
    const claimed: Family = declared.has("pdf")
      ? "pdf"
      : declared.has("zip")
        ? "zip"
        : "image";
    return {
      ok: false,
      reason: `This file is named like ${humanFamily(
        claimed
      )} but its contents are ${humanSniff(
        null
      )}. Re-export or rename the file and try again.`,
    };
  }

  // CSV / plain text / an unsniffable-but-plausible upload: trust the extension,
  // but force a benign attachment-only MIME.
  return { ok: true, mime: textFallbackMime(opts.filename) };
}
