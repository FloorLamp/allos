import { describe, it, expect } from "vitest";
import { sniffMime, sniffUploadType } from "@/lib/file-sniff";

// Synthetic byte-prefix fixtures only — Buffers built inline, never a real
// document or binary fixture file (see the PHI convention in CLAUDE.md).

// A Buffer from a mix of raw byte values and ASCII strings, padded with trailing
// zeros so length-sensitive checks (e.g. WebP's offset-8 "WEBP") have room.
function buf(parts: Array<number | string>, padTo = 0): Buffer {
  const chunks: Buffer[] = parts.map((p) =>
    typeof p === "number" ? Buffer.from([p]) : Buffer.from(p, "latin1")
  );
  let b = Buffer.concat(chunks);
  if (b.length < padTo) b = Buffer.concat([b, Buffer.alloc(padTo - b.length)]);
  return b;
}

const PNG_MAGIC = buf([0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = buf([0xff, 0xd8, 0xff, 0xe0]);
const GIF_MAGIC = buf(["GIF89a"]);
const WEBP_MAGIC = buf(["RIFF", 0x00, 0x00, 0x00, 0x00, "WEBP"]);
const TIFF_LE = buf([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE = buf([0x4d, 0x4d, 0x00, 0x2a]);
const ZIP_MAGIC = buf([0x50, 0x4b, 0x03, 0x04]);
const PDF_MAGIC = buf(["%PDF-1.7\n%âãÏÓ\n"]);

// ISO-BMFF ftyp box: 4-byte length, "ftyp", 4-byte major brand.
function ftyp(brand: string): Buffer {
  return buf([0x00, 0x00, 0x00, 0x18, "ftyp", brand, "mif1"], 24);
}

describe("sniffMime", () => {
  it("detects PDF (magic at start)", () => {
    expect(sniffMime(PDF_MAGIC)).toBe("application/pdf");
  });

  it("detects PDF when the signature is a little past the start", () => {
    const padded = Buffer.concat([Buffer.from("\n\n   "), PDF_MAGIC]);
    expect(sniffMime(padded)).toBe("application/pdf");
  });

  it("detects PNG / JPEG / GIF / WebP / TIFF", () => {
    expect(sniffMime(PNG_MAGIC)).toBe("image/png");
    expect(sniffMime(JPEG_MAGIC)).toBe("image/jpeg");
    expect(sniffMime(GIF_MAGIC)).toBe("image/gif");
    expect(sniffMime(buf(["GIF87a"]))).toBe("image/gif");
    expect(sniffMime(WEBP_MAGIC)).toBe("image/webp");
    expect(sniffMime(TIFF_LE)).toBe("image/tiff");
    expect(sniffMime(TIFF_BE)).toBe("image/tiff");
  });

  it("detects HEIC vs HEIF by ftyp brand, and ignores non-HEIF ftyp brands", () => {
    expect(sniffMime(ftyp("heic"))).toBe("image/heic");
    expect(sniffMime(ftyp("heix"))).toBe("image/heic");
    expect(sniffMime(ftyp("mif1"))).toBe("image/heif");
    expect(sniffMime(ftyp("heif"))).toBe("image/heif");
    // An MP4/MOV container is also an ftyp box but not a supported image → null.
    expect(sniffMime(ftyp("mp42"))).toBeNull();
    expect(sniffMime(ftyp("isom"))).toBeNull();
  });

  it("detects ZIP (local, empty, spanned headers)", () => {
    expect(sniffMime(ZIP_MAGIC)).toBe("application/zip");
    expect(sniffMime(buf([0x50, 0x4b, 0x05, 0x06]))).toBe("application/zip");
    expect(sniffMime(buf([0x50, 0x4b, 0x07, 0x08]))).toBe("application/zip");
  });

  it("detects XML / C-CDA, tolerating a BOM and leading whitespace", () => {
    expect(sniffMime(buf(['<?xml version="1.0"?>']))).toBe("application/xml");
    expect(sniffMime(buf([0xef, 0xbb, 0xbf, "<?xml ?>"]))).toBe(
      "application/xml"
    );
    expect(sniffMime(buf(["  \n<?xml?>"]))).toBe("application/xml");
    expect(sniffMime(buf(['<ClinicalDocument xmlns="urn:hl7-org:v3">']))).toBe(
      "application/xml"
    );
  });

  it("detects JSON (leading { or [) for FHIR/SHC, tolerating whitespace/BOM", () => {
    expect(sniffMime(buf(['{"resourceType":"Bundle"}']))).toBe(
      "application/json"
    );
    expect(sniffMime(buf(["\n  [1,2,3]"]))).toBe("application/json");
    expect(sniffMime(buf([0xef, 0xbb, 0xbf, "{}"]))).toBe("application/json");
  });

  it("returns null for text-ish and unrecognized content", () => {
    expect(sniffMime(Buffer.from(""))).toBeNull();
    expect(sniffMime(Buffer.from("name,value\nGlucose,95\n"))).toBeNull();
    // A bare compact JWS (SMART Health Card) is base64url text with no magic.
    expect(
      sniffMime(Buffer.from("eyJhbGciOiJFUzI1NiJ9.eyJ4Ijoi.sig"))
    ).toBeNull();
    expect(sniffMime(Buffer.from("just some plain text"))).toBeNull();
  });
});

describe("sniffUploadType", () => {
  it("accepts a matching file and stores the byte-derived MIME", () => {
    expect(
      sniffUploadType({
        filename: "labs.pdf",
        declaredMime: "application/pdf",
        buffer: PDF_MAGIC,
      })
    ).toEqual({ ok: true, mime: "application/pdf" });

    expect(
      sniffUploadType({
        filename: "scan.jpg",
        declaredMime: "image/jpeg",
        buffer: JPEG_MAGIC,
      })
    ).toEqual({ ok: true, mime: "image/jpeg" });
  });

  it("stores the TRUE image type even when the extension disagrees within the image family", () => {
    // Named .jpg but actually a PNG → not a contradiction (both images); store png.
    expect(
      sniffUploadType({
        filename: "scan.jpg",
        declaredMime: "image/jpeg",
        buffer: PNG_MAGIC,
      })
    ).toEqual({ ok: true, mime: "image/png" });
  });

  it("rejects a file whose bytes contradict its declared type (a fake PDF)", () => {
    const r = sniffUploadType({
      filename: "report.pdf",
      declaredMime: "application/pdf",
      buffer: PNG_MAGIC,
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.reason).toMatch(/named like a PDF/i);
    expect(r.reason).toMatch(/PNG image/i);
  });

  it("rejects a magic-bearing extension whose contents have no magic", () => {
    // Named .png but the bytes are plain HTML/text (no PNG magic).
    const r = sniffUploadType({
      filename: "evil.png",
      declaredMime: "image/png",
      buffer: Buffer.from("<html><script>alert(1)</script></html>"),
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.reason).toMatch(/named like an image/i);
  });

  it("rejects a .pdf with no PDF magic", () => {
    const r = sniffUploadType({
      filename: "notes.pdf",
      declaredMime: "application/pdf",
      buffer: Buffer.from("this is not a pdf at all"),
    });
    expect(r.ok).toBe(false);
  });

  it("accepts CSV/plain text and forces a benign attachment-only MIME", () => {
    expect(
      sniffUploadType({
        filename: "results.csv",
        declaredMime: "text/csv",
        buffer: Buffer.from("name,value\nGlucose,95\n"),
      })
    ).toEqual({ ok: true, mime: "text/csv" });

    expect(
      sniffUploadType({
        filename: "notes.txt",
        declaredMime: "text/plain",
        buffer: Buffer.from("free text notes"),
      })
    ).toEqual({ ok: true, mime: "text/plain" });
  });

  it("does not let a mislabeled text/html be stored as an inline-served type", () => {
    // A .csv whose declared MIME lies as text/html still stores as text/csv,
    // which is not in the serve route's INLINE_OK set (forced download).
    const r = sniffUploadType({
      filename: "data.csv",
      declaredMime: "text/html",
      buffer: Buffer.from("a,b\n1,2\n"),
    });
    expect(r).toEqual({ ok: true, mime: "text/csv" });
  });

  it("accepts an xlsx (ZIP) and rejects an xlsx that isn't a ZIP", () => {
    expect(
      sniffUploadType({
        filename: "labs.xlsx",
        declaredMime:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: ZIP_MAGIC,
      })
    ).toEqual({ ok: true, mime: "application/zip" });

    const r = sniffUploadType({
      filename: "labs.xlsx",
      declaredMime: "application/octet-stream",
      buffer: Buffer.from("not a zip"),
    });
    expect(r.ok).toBe(false);
  });

  it("trusts the bytes when the declaration is ambiguous (no extension, octet-stream)", () => {
    expect(
      sniffUploadType({
        filename: "upload",
        declaredMime: "application/octet-stream",
        buffer: PNG_MAGIC,
      })
    ).toEqual({ ok: true, mime: "image/png" });
  });

  it("prefers the bytes when the extension and declared MIME disagree with each other", () => {
    // image/png MIME on a .pdf name, but the bytes really are a PDF → store pdf.
    expect(
      sniffUploadType({
        filename: "report.pdf",
        declaredMime: "image/png",
        buffer: PDF_MAGIC,
      })
    ).toEqual({ ok: true, mime: "application/pdf" });
  });

  it("is lenient about an unsniffable-but-plausible image extension (e.g. .bmp)", () => {
    // .bmp has no magic in our detector — we don't false-reject it, and we store a
    // benign attachment-only type rather than an inline image/* type.
    const r = sniffUploadType({
      filename: "old.bmp",
      declaredMime: "image/bmp",
      buffer: Buffer.from("BM some bitmap-ish bytes"),
    });
    expect(r).toEqual({ ok: true, mime: "application/octet-stream" });
  });

  describe("health records are exempt from rejection", () => {
    it("stores a byte-derived MIME for a CDA and never rejects", () => {
      expect(
        sniffUploadType({
          filename: "export.xml",
          declaredMime: "application/xml",
          buffer: buf(['<ClinicalDocument xmlns="urn:hl7-org:v3">']),
          isHealthRecord: true,
        })
      ).toEqual({ ok: true, mime: "application/xml" });
    });

    it("falls back to octet-stream for a SHC with no magic (bare JWS text)", () => {
      expect(
        sniffUploadType({
          filename: "card.smart-health-card",
          declaredMime: "application/octet-stream",
          buffer: Buffer.from("eyJ.eyJ.sig"),
          isHealthRecord: true,
        })
      ).toEqual({ ok: true, mime: "application/octet-stream" });
    });
  });
});
