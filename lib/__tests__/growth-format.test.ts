import { describe, it, expect } from "vitest";
import { ordinalPercentile } from "../growth-format";

describe("ordinalPercentile", () => {
  it("formats ordinals with the right suffix", () => {
    expect(ordinalPercentile(40)).toBe("40th");
    expect(ordinalPercentile(1)).toBe("1st");
    expect(ordinalPercentile(2)).toBe("2nd");
    expect(ordinalPercentile(3)).toBe("3rd");
    expect(ordinalPercentile(21)).toBe("21st");
    expect(ordinalPercentile(97)).toBe("97th");
  });
  it("uses 'th' for the 11–13 teens", () => {
    expect(ordinalPercentile(11)).toBe("11th");
    expect(ordinalPercentile(12)).toBe("12th");
    expect(ordinalPercentile(13)).toBe("13th");
  });
  it("rounds to the nearest whole percentile", () => {
    expect(ordinalPercentile(49.6)).toBe("50th");
    expect(ordinalPercentile(24.2)).toBe("24th");
  });
  it("clamps the tails", () => {
    expect(ordinalPercentile(0.4)).toBe("<1st");
    expect(ordinalPercentile(99.7)).toBe(">99th");
  });
});
