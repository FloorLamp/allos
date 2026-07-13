import { describe, it, expect } from "vitest";
import {
  isValidLat,
  isValidLng,
  roundCoord,
  normalizeHome,
  parseHome,
  extractZip5,
  zipToHome,
} from "../home-location";

describe("coordinate validation", () => {
  it("bounds latitude and longitude", () => {
    expect(isValidLat(45)).toBe(true);
    expect(isValidLat(-91)).toBe(false);
    expect(isValidLng(-74)).toBe(true);
    expect(isValidLng(181)).toBe(false);
    expect(isValidLat(NaN)).toBe(false);
  });
});

describe("roundCoord — coarse storage (~11km)", () => {
  it("rounds to one decimal place", () => {
    expect(roundCoord(40.7128)).toBe(40.7);
    expect(roundCoord(-74.006)).toBe(-74);
    expect(roundCoord(18.36)).toBe(18.4);
  });
});

describe("normalizeHome", () => {
  it("coarsens a valid pair", () => {
    expect(normalizeHome(40.7128, -74.006)).toEqual({ lat: 40.7, lng: -74 });
  });
  it("rejects out-of-range coordinates", () => {
    expect(normalizeHome(200, 0)).toBeNull();
    expect(normalizeHome(0, 999)).toBeNull();
  });
});

describe("parseHome", () => {
  it("parses numeric strings and coarsens", () => {
    expect(parseHome("40.7128", "-74.006")).toEqual({ lat: 40.7, lng: -74 });
  });
  it("is null for blank / missing / invalid", () => {
    expect(parseHome("", "")).toBeNull();
    expect(parseHome(null, -74)).toBeNull();
    expect(parseHome("abc", "1")).toBeNull();
  });
});

describe("extractZip5", () => {
  it("pulls a 5-digit ZIP from ZIP+4 and free text", () => {
    expect(extractZip5("10001")).toBe("10001");
    expect(extractZip5("10001-1234")).toBe("10001");
    expect(extractZip5("Springfield, IL 62704")).toBe("62704");
  });
  it("is null when there's no ZIP", () => {
    expect(extractZip5("no digits here")).toBeNull();
    expect(extractZip5(null)).toBeNull();
  });
});

describe("zipToHome — offline centroid lookup", () => {
  it("resolves a known US ZIP to a coarse centroid", () => {
    const home = zipToHome("10001"); // Manhattan
    expect(home).not.toBeNull();
    // Coarse (1-decimal) by construction.
    expect(home!.lat).toBeCloseTo(40.8, 1);
    expect(home!.lng).toBeCloseTo(-74, 1);
  });
  it("handles a ZIP+4 form", () => {
    expect(zipToHome("10001-1234")).toEqual(zipToHome("10001"));
  });
  it("is null for a non-US / unknown postal code (stays manual)", () => {
    expect(zipToHome("SW1A 1AA")).toBeNull();
    expect(zipToHome("00000")).toBeNull();
  });
});
