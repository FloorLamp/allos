import { describe, it, expect } from "vitest";
import {
  isSafeNextPath,
  safeNextPath,
  truncateUserAgent,
} from "../login-security";

describe("isSafeNextPath / safeNextPath", () => {
  it("accepts same-origin relative paths", () => {
    for (const p of ["/", "/settings", "/medical/file/3", "/a?b=c#d"]) {
      expect(isSafeNextPath(p)).toBe(true);
    }
  });

  it("rejects open-redirect and non-path inputs", () => {
    for (const p of [
      "",
      "settings", // not absolute
      "//evil.com", // protocol-relative
      "/\\evil.com", // backslash protocol-relative
      "http://evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "/foo:bar", // scheme-like segment
      "/foo\nbar", // control char
      null,
      undefined,
      42,
    ]) {
      expect(isSafeNextPath(p as unknown)).toBe(false);
    }
  });

  it("falls back when unsafe", () => {
    expect(safeNextPath("//evil.com")).toBe("/");
    expect(safeNextPath("/ok")).toBe("/ok");
    expect(safeNextPath(undefined, "/home")).toBe("/home");
  });
});

describe("truncateUserAgent", () => {
  it("returns null for a missing/empty/non-string header", () => {
    expect(truncateUserAgent(null)).toBeNull();
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent("")).toBeNull();
    expect(truncateUserAgent("   ")).toBeNull();
    expect(truncateUserAgent(42)).toBeNull();
  });

  it("trims and collapses internal whitespace", () => {
    expect(truncateUserAgent("  Mozilla/5.0   (X11;\tLinux)  ")).toBe(
      "Mozilla/5.0 (X11; Linux)"
    );
  });

  it("caps overly long user agents", () => {
    const long = "A".repeat(500);
    expect(truncateUserAgent(long, 200)).toHaveLength(200);
    expect(truncateUserAgent("short", 200)).toBe("short");
  });
});
