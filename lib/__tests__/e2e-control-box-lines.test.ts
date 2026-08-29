import { describe, expect, it } from "vitest";
import { roundControlBoxExtraLines } from "../../e2e/control-box-lines";

describe("E2E control-box line count", () => {
  it("normalizes Chromium's valid below-floor subpixel reading to positive zero", () => {
    const extra = (33.99993896484375 - 34) / 24;

    expect(Object.is(Math.round(extra), -0)).toBe(true);
    expect(roundControlBoxExtraLines(extra)).toBe(0);
  });

  it("preserves real negative and positive line counts", () => {
    expect(roundControlBoxExtraLines(-0.6)).toBe(-1);
    expect(roundControlBoxExtraLines(0.6)).toBe(1);
    expect(roundControlBoxExtraLines(1.4)).toBe(1);
  });
});
