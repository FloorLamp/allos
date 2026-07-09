import { describe, it, expect } from "vitest";
import {
  normalizeSex,
  normalizeBirthdate,
  normalizeAge,
} from "@/lib/medical-extract";

describe("normalizeSex", () => {
  it("maps male spellings to 'male'", () => {
    expect(normalizeSex("M")).toBe("male");
    expect(normalizeSex("male")).toBe("male");
    expect(normalizeSex("Male")).toBe("male");
    expect(normalizeSex("MALE")).toBe("male");
    expect(normalizeSex("man")).toBe("male");
    expect(normalizeSex("  m ")).toBe("male");
  });

  it("maps female spellings to 'female'", () => {
    expect(normalizeSex("F")).toBe("female");
    expect(normalizeSex("female")).toBe("female");
    expect(normalizeSex("Female")).toBe("female");
    expect(normalizeSex("FEMALE")).toBe("female");
    expect(normalizeSex("woman")).toBe("female");
  });

  it("returns null for absent or unrecognized values", () => {
    expect(normalizeSex(null)).toBeNull();
    expect(normalizeSex(undefined)).toBeNull();
    expect(normalizeSex("")).toBeNull();
    expect(normalizeSex("unknown")).toBeNull();
    expect(normalizeSex("other")).toBeNull();
    expect(normalizeSex("X")).toBeNull();
    expect(normalizeSex(1)).toBeNull();
  });
});

describe("normalizeBirthdate", () => {
  it("accepts a strict ISO YYYY-MM-DD date", () => {
    expect(normalizeBirthdate("1985-04-20")).toBe("1985-04-20");
    expect(normalizeBirthdate("  1985-04-20 ")).toBe("1985-04-20");
  });

  it("rejects non-ISO or partial dates", () => {
    expect(normalizeBirthdate("1985")).toBeNull();
    expect(normalizeBirthdate("04/20/1985")).toBeNull();
    expect(normalizeBirthdate("Apr 20 1985")).toBeNull();
    expect(normalizeBirthdate("")).toBeNull();
    expect(normalizeBirthdate(null)).toBeNull();
    expect(normalizeBirthdate(19850420)).toBeNull();
  });
});

describe("normalizeAge", () => {
  it("accepts plausible ages from numbers and numeric strings", () => {
    expect(normalizeAge(45)).toBe(45);
    expect(normalizeAge("45")).toBe(45);
    expect(normalizeAge("45 years")).toBe(45);
    expect(normalizeAge(45.6)).toBe(46);
  });

  it("rejects absent or implausible ages", () => {
    expect(normalizeAge(0)).toBeNull();
    expect(normalizeAge(-3)).toBeNull();
    expect(normalizeAge(200)).toBeNull();
    expect(normalizeAge("")).toBeNull();
    expect(normalizeAge("old")).toBeNull();
    expect(normalizeAge(null)).toBeNull();
  });
});
