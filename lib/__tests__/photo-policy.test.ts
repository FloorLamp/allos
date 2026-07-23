// The photo core's pure sizing + default-date policy (#1119): fitWithin drives
// BOTH the client canvas capture and the server resize (the DB-tier ingest test
// asserts sharp's output dims equal fitWithin's answer — one computation, #221),
// and resolvePhotoDate is the "photo taken last Tuesday, uploaded today" rule.

import { describe, expect, it } from "vitest";
import {
  fitWithin,
  resolvePhotoDate,
  PHOTO_MAX_EDGE,
  PHOTO_THUMB_EDGE,
} from "../photo/policy";
import { normalizePose, PROGRESS_POSES } from "../progress-photos";

describe("fitWithin", () => {
  it("caps the long edge and preserves aspect ratio", () => {
    expect(fitWithin(4096, 3072, PHOTO_MAX_EDGE)).toEqual({
      width: 2048,
      height: 1536,
      scaled: true,
    });
    expect(fitWithin(3072, 4096, PHOTO_MAX_EDGE)).toEqual({
      width: 1536,
      height: 2048,
      scaled: true,
    });
  });

  it("never enlarges", () => {
    expect(fitWithin(800, 600, PHOTO_MAX_EDGE)).toEqual({
      width: 800,
      height: 600,
      scaled: false,
    });
    expect(fitWithin(PHOTO_MAX_EDGE, 100, PHOTO_MAX_EDGE).scaled).toBe(false);
  });

  it("thumbnail box works the same way", () => {
    const t = fitWithin(2048, 1536, PHOTO_THUMB_EDGE);
    expect(t).toEqual({ width: 320, height: 240, scaled: true });
  });

  it("floors at 1px on extreme ratios and rounds fractional input", () => {
    const r = fitWithin(10000, 2, PHOTO_MAX_EDGE);
    expect(r.width).toBe(2048);
    expect(r.height).toBeGreaterThanOrEqual(1);
    expect(fitWithin(99.6, 50.4, 2048)).toEqual({
      width: 100,
      height: 50,
      scaled: false,
    });
  });
});

describe("resolvePhotoDate", () => {
  const TODAY = "2026-07-01";
  it("an explicit user date always wins", () => {
    expect(resolvePhotoDate("2026-06-01", "2026-05-05", TODAY)).toBe(
      "2026-06-01"
    );
  });
  it("falls back to the EXIF capture date (taken last Tuesday, uploaded today)", () => {
    expect(resolvePhotoDate(null, "2026-06-23", TODAY)).toBe("2026-06-23");
    expect(resolvePhotoDate("", "2026-06-23", TODAY)).toBe("2026-06-23");
  });
  it("never accepts a FUTURE capture date (wrong camera clock)", () => {
    expect(resolvePhotoDate(null, "2027-01-01", TODAY)).toBe(TODAY);
  });
  it("defaults to today when nothing else is valid", () => {
    expect(resolvePhotoDate(null, null, TODAY)).toBe(TODAY);
    expect(resolvePhotoDate("garbage", "also-garbage", TODAY)).toBe(TODAY);
  });
});

describe("normalizePose", () => {
  it("accepts the vocabulary case-insensitively", () => {
    for (const p of PROGRESS_POSES) {
      expect(normalizePose(p)).toBe(p);
      expect(normalizePose(p.toUpperCase())).toBe(p);
    }
    expect(normalizePose("  Front ")).toBe("front");
  });
  it("rejects off-vocabulary poses (never silently coerced)", () => {
    expect(normalizePose("flex")).toBeNull();
    expect(normalizePose("")).toBeNull();
    expect(normalizePose(null)).toBeNull();
    expect(normalizePose(undefined)).toBeNull();
  });
});
