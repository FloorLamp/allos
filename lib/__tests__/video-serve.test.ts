// PURE tier — HTTP Range header parsing for the video serve helper (#1224). The
// byte-serving side (fs streams) lives in the DB/e2e tiers; this pins the range
// math that decides 200 vs 206 vs 416.

import { describe, it, expect } from "vitest";
import { parseRange } from "@/lib/video/serve";

describe("parseRange", () => {
  const size = 1000;

  it("returns null (serve whole file) when there is no Range header", () => {
    expect(parseRange(null, size)).toBeNull();
  });

  it("parses a bounded range", () => {
    expect(parseRange("bytes=0-499", size)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=200-799", size)).toEqual({ start: 200, end: 799 });
  });

  it("parses an open-ended range to the last byte", () => {
    expect(parseRange("bytes=500-", size)).toEqual({ start: 500, end: 999 });
  });

  it("parses a suffix range (last N bytes)", () => {
    expect(parseRange("bytes=-100", size)).toEqual({ start: 900, end: 999 });
    // A suffix larger than the file clamps to the whole file.
    expect(parseRange("bytes=-5000", size)).toEqual({ start: 0, end: 999 });
  });

  it("clamps an end past EOF", () => {
    expect(parseRange("bytes=900-9999", size)).toEqual({
      start: 900,
      end: 999,
    });
  });

  it("rejects a malformed or unsatisfiable range as invalid (→ 416)", () => {
    expect(parseRange("bytes=abc", size)).toBe("invalid");
    expect(parseRange("bytes=-", size)).toBe("invalid");
    expect(parseRange("bytes=500-200", size)).toBe("invalid"); // start > end
    expect(parseRange("bytes=1000-1001", size)).toBe("invalid"); // start >= size
    expect(parseRange("items=0-10", size)).toBe("invalid"); // wrong unit
  });
});
