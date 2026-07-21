import { describe, it, expect } from "vitest";
import {
  nuccLabel,
  NUCC_LABELS,
  NUCC_LABEL_OPTIONS,
} from "@/lib/nucc-taxonomy";

// The curated NUCC code → label map (issue #1056): a curated code resolves to its
// label; an uncurated code falls back to the document's own displayName; a bare
// uncurated code with no display keeps `specialty` null (the code alone is retained
// for identity by the caller).
describe("nuccLabel", () => {
  it("resolves a curated code to its display label (case-insensitive)", () => {
    expect(nuccLabel("207R00000X")).toBe("Internal Medicine");
    expect(nuccLabel("207rc0000x")).toBe("Cardiology");
    expect(nuccLabel("152W00000X")).toBe("Optometry");
  });

  it("prefers the curated label over the document displayName", () => {
    // The source may print its own (sometimes verbose) label; the curated one wins.
    expect(nuccLabel("207RC0000X", "Cardiovascular Disease")).toBe(
      "Cardiology"
    );
  });

  it("falls back to the document displayName for an uncurated code", () => {
    expect(nuccLabel("999ZZ9999X", "Hyperbaric Medicine")).toBe(
      "Hyperbaric Medicine"
    );
  });

  it("returns null for an uncurated code with no displayName", () => {
    expect(nuccLabel("999ZZ9999X")).toBeNull();
    expect(nuccLabel(null)).toBeNull();
    expect(nuccLabel("")).toBeNull();
  });

  it("exposes a non-trivial, de-duplicated, sorted option list", () => {
    expect(NUCC_LABEL_OPTIONS.length).toBeGreaterThan(20);
    expect(new Set(NUCC_LABEL_OPTIONS).size).toBe(NUCC_LABEL_OPTIONS.length);
    const sorted = [...NUCC_LABEL_OPTIONS].sort((a, b) => a.localeCompare(b));
    expect(NUCC_LABEL_OPTIONS).toEqual(sorted);
    // The options are exactly the curated label values.
    expect(new Set(NUCC_LABEL_OPTIONS)).toEqual(
      new Set(Object.values(NUCC_LABELS))
    );
  });
});
