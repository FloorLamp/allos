import { describe, expect, it } from "vitest";
import { strOrNull } from "@/lib/parse";

describe("strOrNull", () => {
  it("trims a non-empty string", () => {
    expect(strOrNull("  hi  ")).toBe("hi");
    expect(strOrNull("hi")).toBe("hi");
  });

  it("returns null for blank or whitespace-only strings", () => {
    expect(strOrNull("")).toBeNull();
    expect(strOrNull("   ")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(strOrNull(null)).toBeNull();
    expect(strOrNull(undefined)).toBeNull();
    expect(strOrNull(42)).toBeNull();
    expect(strOrNull({})).toBeNull();
  });
});
