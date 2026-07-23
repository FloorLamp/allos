// PURE tier — the video-core caps + default-date policy (#1224).

import { describe, it, expect } from "vitest";
import {
  checkVideoCaps,
  resolveVideoDate,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_SECONDS,
} from "@/lib/video/policy";

describe("checkVideoCaps", () => {
  it("accepts a clip within both caps", () => {
    expect(checkVideoCaps(1_000_000, 30)).toEqual({ ok: true });
    // A clip a hair over 60s is within the rounding grace.
    expect(checkVideoCaps(1_000_000, 60.4).ok).toBe(true);
  });

  it("rejects an empty file", () => {
    expect(checkVideoCaps(0, 10).ok).toBe(false);
  });

  it("rejects a clip over the byte cap", () => {
    const d = checkVideoCaps(MAX_VIDEO_BYTES + 1, 5);
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/100 MB/);
  });

  it("rejects a clip meaningfully over the 60s cap", () => {
    const d = checkVideoCaps(1_000_000, MAX_VIDEO_SECONDS + 30);
    expect(d.ok).toBe(false);
    expect(d.error).toMatch(/60 seconds/);
  });

  it("passes an unmeasured-duration clip on length (byte cap still guards)", () => {
    // A container the sniffer couldn't measure (Ogg/MP3) has null duration; the
    // length gate can't apply, so only the byte cap decides.
    expect(checkVideoCaps(1_000_000, null).ok).toBe(true);
    expect(checkVideoCaps(MAX_VIDEO_BYTES + 1, null).ok).toBe(false);
  });
});

describe("resolveVideoDate", () => {
  const today = "2026-07-23";

  it("prefers an explicit valid date over everything", () => {
    expect(resolveVideoDate("2026-07-01", "2026-03-14", today)).toBe(
      "2026-07-01"
    );
  });

  it("falls back to the harvested container date when no explicit date", () => {
    expect(resolveVideoDate(null, "2026-03-14", today)).toBe("2026-03-14");
  });

  it("never lets a FUTURE container date push past today", () => {
    expect(resolveVideoDate(null, "2027-01-01", today)).toBe(today);
  });

  it("falls back to today when neither date is usable", () => {
    expect(resolveVideoDate(null, null, today)).toBe(today);
    expect(resolveVideoDate("not-a-date", "also-bad", today)).toBe(today);
  });
});
