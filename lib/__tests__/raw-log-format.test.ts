import { describe, it, expect } from "vitest";
import {
  isSafeRawRef,
  capPayload,
  MAX_PAYLOAD_BYTES,
} from "@/lib/integrations/raw-log-format";

// Pure-tier tests for the raw-payload store's safety helpers (issue #9). The
// fs-bound writer/reader live in raw-log.ts and are exercised in the DB/e2e tiers;
// here we lock down the path-traversal guard and the byte cap.

describe("isSafeRawRef", () => {
  it("accepts the bare filenames the writer produces", () => {
    expect(
      isSafeRawRef("health-connect-1f2e3d4c-5b6a-7089-abcd-ef0123456789.json")
    ).toBe(true);
    expect(isSafeRawRef("strava-abc123.json")).toBe(true);
    expect(isSafeRawRef("a")).toBe(true);
    expect(isSafeRawRef("under_score.json")).toBe(true);
  });

  it("rejects anything that could escape the profile directory", () => {
    expect(isSafeRawRef("")).toBe(false);
    expect(isSafeRawRef(".")).toBe(false);
    expect(isSafeRawRef("..")).toBe(false);
    expect(isSafeRawRef("../secret.json")).toBe(false);
    expect(isSafeRawRef("a/b.json")).toBe(false);
    expect(isSafeRawRef("a\\b.json")).toBe(false);
    expect(isSafeRawRef("/etc/passwd")).toBe(false);
    expect(isSafeRawRef("spaces bad.json")).toBe(false);
    expect(isSafeRawRef("nul\0.json")).toBe(false);
  });

  it("rejects over-long refs", () => {
    expect(isSafeRawRef("a".repeat(128))).toBe(true);
    expect(isSafeRawRef("a".repeat(129))).toBe(false);
  });
});

describe("capPayload", () => {
  it("returns short payloads unchanged", () => {
    const s = '{"ok":true}';
    expect(capPayload(s)).toBe(s);
    expect(capPayload("", 10)).toBe("");
  });

  it("truncates over-cap payloads with a byte-count marker", () => {
    const s = "x".repeat(100);
    const out = capPayload(s, 40);
    expect(out.startsWith("x".repeat(40))).toBe(true);
    expect(out).toContain("truncated 60 bytes");
    // The truncated body itself is at most the cap plus the marker.
    expect(out.length).toBeLessThan(s.length + 40);
  });

  it("caps on BYTES, not code points (multibyte-aware)", () => {
    // "€" is 3 UTF-8 bytes; 10 of them = 30 bytes, over a 12-byte cap.
    const s = "€".repeat(10);
    const out = capPayload(s, 12);
    expect(Buffer.byteLength(s, "utf8")).toBe(30);
    expect(out).toContain("truncated");
  });

  it("defaults to MAX_PAYLOAD_BYTES", () => {
    const big = "y".repeat(MAX_PAYLOAD_BYTES + 5);
    expect(capPayload(big)).toContain("truncated 5 bytes");
  });
});
