// The photo core's EXIF privacy contract (#1119): harvest the capture date (and
// ONLY the capture date — GPS is never decoded), detect a GPS block so the
// pipeline's strip-verification has teeth, and never throw on malformed bytes.
// Fixtures are built by the synthetic serializer in lib/photo/exif-fixture.ts —
// no real photograph (or real capture metadata) exists anywhere in the repo.

import { describe, expect, it } from "vitest";
import {
  readJpegExif,
  readTiffExif,
  exifDateToIso,
  EMPTY_EXIF_SUMMARY,
} from "../photo/exif";
import {
  buildMinimalExifJpeg,
  buildTiffBlock,
  spliceExifIntoJpeg,
} from "../photo/exif-fixture";

describe("exifDateToIso", () => {
  it("converts the EXIF date form and keeps only the date", () => {
    expect(exifDateToIso("2026:03:14 09:26:53")).toBe("2026-03-14");
  });
  it("rejects placeholders and impossible dates", () => {
    expect(exifDateToIso("0000:00:00 00:00:00")).toBeNull();
    expect(exifDateToIso("2026:02:30 10:00:00")).toBeNull();
    expect(exifDateToIso("not a date")).toBeNull();
    expect(exifDateToIso(null)).toBeNull();
    expect(exifDateToIso("")).toBeNull();
  });
});

describe("readJpegExif — harvest", () => {
  it("reads DateTimeOriginal as the capture date", () => {
    const jpeg = buildMinimalExifJpeg({
      dateTimeOriginal: "2026:03:14 09:26:53",
    });
    const s = readJpegExif(jpeg);
    expect(s.hasExif).toBe(true);
    expect(s.captureDate).toBe("2026-03-14");
  });

  it("falls back to IFD0 DateTime when DateTimeOriginal is absent", () => {
    const jpeg = buildMinimalExifJpeg({ dateTime: "2025:12:01 08:00:00" });
    expect(readJpegExif(jpeg).captureDate).toBe("2025-12-01");
  });

  it("prefers DateTimeOriginal over DateTime", () => {
    const jpeg = buildMinimalExifJpeg({
      dateTimeOriginal: "2026:01:02 10:00:00",
      dateTime: "2026:05:06 10:00:00", // e.g. a later edit timestamp
    });
    expect(readJpegExif(jpeg).captureDate).toBe("2026-01-02");
  });

  it("reads the orientation tag", () => {
    const jpeg = buildMinimalExifJpeg({ orientation: 6 });
    expect(readJpegExif(jpeg).orientation).toBe(6);
  });

  it("detects a GPS IFD without ever decoding coordinates", () => {
    const withGps = readJpegExif(buildMinimalExifJpeg({ gps: true }));
    expect(withGps.hasGps).toBe(true);
    const without = readJpegExif(
      buildMinimalExifJpeg({ dateTimeOriginal: "2026:03:14 09:26:53" })
    );
    expect(without.hasGps).toBe(false);
    // The summary SHAPE carries no coordinate-bearing field at all — the
    // "never harvested" guarantee is structural, not behavioral.
    expect(Object.keys(withGps).sort()).toEqual([
      "captureDate",
      "hasExif",
      "hasGps",
      "orientation",
    ]);
  });

  it("splices into a real JPEG body and still parses (the strip-test fixture path)", () => {
    // A bare-bones JPEG-looking body after SOI (a real one is used in the DB
    // tier; here only the segment walk matters).
    const base = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const spliced = spliceExifIntoJpeg(base, {
      gps: true,
      dateTimeOriginal: "2026:03:14 09:26:53",
    });
    const s = readJpegExif(spliced);
    expect(s.hasGps).toBe(true);
    expect(s.captureDate).toBe("2026-03-14");
  });
});

describe("readJpegExif — robustness (never throws, never false-positives)", () => {
  it("returns the empty summary for non-JPEG bytes", () => {
    expect(readJpegExif(Buffer.from("plainly not an image"))).toEqual(
      EMPTY_EXIF_SUMMARY
    );
    expect(readJpegExif(Buffer.alloc(0))).toEqual(EMPTY_EXIF_SUMMARY);
    // PNG signature
    expect(
      readJpegExif(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )
    ).toEqual(EMPTY_EXIF_SUMMARY);
  });

  it("returns the empty summary for a JPEG with no APP1 segment", () => {
    // SOI, a DQT-ish segment, EOI
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9,
    ]);
    expect(readJpegExif(jpeg)).toEqual(EMPTY_EXIF_SUMMARY);
  });

  it("survives truncated/garbage TIFF payloads", () => {
    const good = buildMinimalExifJpeg({
      dateTimeOriginal: "2026:03:14 09:26:53",
    });
    for (const cut of [4, 8, 12, 20, good.length - 3]) {
      expect(() => readJpegExif(good.subarray(0, cut))).not.toThrow();
    }
    // Structurally valid APP1 wrapper around garbage TIFF bytes: hasExif is
    // true (a metadata block IS present — the strip check must still fire) but
    // nothing is harvested.
    const garbage = readTiffExif(Buffer.from("IIxxgarbage-not-tiff"));
    expect(garbage.hasExif).toBe(true);
    expect(garbage.captureDate).toBeNull();
    expect(garbage.hasGps).toBe(false);
  });
});
