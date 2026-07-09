import { describe, it, expect } from "vitest";
import { shortSha } from "@/lib/version";

describe("shortSha", () => {
  it("truncates a full 40-char sha to 7 chars", () => {
    expect(shortSha("1234567890abcdef1234567890abcdef12345678")).toBe(
      "1234567"
    );
  });

  it("passes a 7-char short sha through unchanged", () => {
    expect(shortSha("08b61c2")).toBe("08b61c2");
  });

  it("trims surrounding whitespace and lowercases", () => {
    expect(shortSha("  08B61C2f\n")).toBe("08b61c2");
  });

  it("returns null for empty, missing, or whitespace-only input", () => {
    expect(shortSha("")).toBeNull();
    expect(shortSha(null)).toBeNull();
    expect(shortSha(undefined)).toBeNull();
    expect(shortSha("   ")).toBeNull();
  });

  it("returns null for non-hex or too-short values", () => {
    expect(shortSha("not-a-sha")).toBeNull();
    expect(shortSha("abc123")).toBeNull(); // only 6 chars
    expect(shortSha("ggggggg")).toBeNull();
  });
});
