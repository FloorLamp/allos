import { describe, expect, it } from "vitest";
import {
  formatSeconds,
  formatMinutes,
  isValidDuration,
  parseSeconds,
} from "@/lib/duration";

describe("formatSeconds", () => {
  it("renders whole seconds as m:ss", () => {
    expect(formatSeconds(90)).toBe("1:30");
    expect(formatSeconds(0)).toBe("0:00");
    expect(formatSeconds(5)).toBe("0:05");
    expect(formatSeconds(600)).toBe("10:00");
  });

  it("rounds fractional seconds and floors negatives to zero", () => {
    expect(formatSeconds(89.4)).toBe("1:29");
    expect(formatSeconds(89.6)).toBe("1:30");
    expect(formatSeconds(-10)).toBe("0:00");
  });

  it("renders an en dash for null/undefined", () => {
    expect(formatSeconds(null)).toBe("–");
    expect(formatSeconds(undefined)).toBe("–");
  });
});

describe("formatMinutes", () => {
  it("renders sub-hour durations as 'N min'", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(0)).toBe("0 min");
    expect(formatMinutes(59)).toBe("59 min");
  });

  it("renders hour-plus durations as 'Hh MMm' with zero-padded minutes", () => {
    expect(formatMinutes(60)).toBe("1h 00m");
    expect(formatMinutes(65)).toBe("1h 05m");
    expect(formatMinutes(150)).toBe("2h 30m");
  });

  it("rounds fractional minutes and floors negatives to zero", () => {
    expect(formatMinutes(44.6)).toBe("45 min");
    expect(formatMinutes(-5)).toBe("0 min");
  });

  it("renders an en dash for null/undefined", () => {
    expect(formatMinutes(null)).toBe("–");
    expect(formatMinutes(undefined)).toBe("–");
  });
});

describe("isValidDuration", () => {
  it("accepts plain whole seconds", () => {
    expect(isValidDuration("90")).toBe(true);
    expect(isValidDuration("0")).toBe(true);
    expect(isValidDuration("  120  ")).toBe(true);
  });

  it("accepts m:ss with the seconds part in 0–59", () => {
    expect(isValidDuration("1:30")).toBe(true);
    expect(isValidDuration("0:45")).toBe(true);
    expect(isValidDuration("12:09")).toBe(true);
    expect(isValidDuration("2:5")).toBe(true);
  });

  it("rejects seconds parts of 60 or more", () => {
    expect(isValidDuration("1:60")).toBe(false);
    expect(isValidDuration("1:99")).toBe(false);
  });

  it("rejects empty, decimal, and non-numeric input", () => {
    expect(isValidDuration("")).toBe(false);
    expect(isValidDuration("   ")).toBe(false);
    expect(isValidDuration("1.5")).toBe(false);
    expect(isValidDuration("abc")).toBe(false);
    expect(isValidDuration("1:")).toBe(false);
  });
});

describe("parseSeconds", () => {
  it("parses m:ss into total seconds", () => {
    expect(parseSeconds("1:30")).toBe(90);
    expect(parseSeconds("0:45")).toBe(45);
    expect(parseSeconds("10:00")).toBe(600);
  });

  it("treats a colon with no seconds part as :00", () => {
    expect(parseSeconds("2:")).toBe(120);
  });

  it("parses plain seconds", () => {
    expect(parseSeconds("90")).toBe(90);
    expect(parseSeconds("  75  ")).toBe(75);
  });

  it("rounds fractional results", () => {
    expect(parseSeconds("89.6")).toBe(90);
  });

  it("returns null for empty or unparseable input", () => {
    expect(parseSeconds("")).toBeNull();
    expect(parseSeconds("   ")).toBeNull();
    expect(parseSeconds("abc")).toBeNull();
    expect(parseSeconds("1:xx")).toBeNull();
  });
});
