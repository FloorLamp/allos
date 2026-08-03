import { describe, expect, it } from "vitest";
import {
  REFILL_RECENCY_WINDOW_MS,
  refillRecencyExpiryMs,
  refillRecencyLine,
} from "@/lib/refill-recency";

// The #1893 defect-2 treatment: an INFORMATIONAL "you just refilled" line on an additive
// affordance (#798), never a gate. These pin the window's two edges and the fact that the
// line only ever describes — it returns a string or nothing, and carries no verdict a
// caller could turn into a block.
describe("refillRecencyLine (#1893)", () => {
  const at = 1_700_000_000_000;

  it("says nothing when no refill has been performed here", () => {
    expect(refillRecencyLine(null, at)).toBeNull();
    expect(refillRecencyLine(undefined, at)).toBeNull();
  });

  it("names the fill INSIDE the window", () => {
    expect(refillRecencyLine({ fillSize: 90, atMs: at }, at)).toBe(
      "Refilled just now (+90)"
    );
    expect(
      refillRecencyLine(
        { fillSize: 90, atMs: at },
        at + REFILL_RECENCY_WINDOW_MS - 1
      )
    ).toBe("Refilled just now (+90)");
  });

  it("is GONE at and after the window edge", () => {
    expect(
      refillRecencyLine(
        { fillSize: 90, atMs: at },
        at + REFILL_RECENCY_WINDOW_MS
      )
    ).toBeNull();
    expect(
      refillRecencyLine(
        { fillSize: 90, atMs: at },
        at + REFILL_RECENCY_WINDOW_MS * 10
      )
    ).toBeNull();
  });

  it("prints fractional fills without trailing zeros", () => {
    expect(refillRecencyLine({ fillSize: 0.5, atMs: at }, at)).toBe(
      "Refilled just now (+0.5)"
    );
    expect(refillRecencyLine({ fillSize: 2.5, atMs: at }, at)).toBe(
      "Refilled just now (+2.5)"
    );
  });

  it("says nothing for a fill size that isn't a positive number", () => {
    expect(refillRecencyLine({ fillSize: 0, atMs: at }, at)).toBeNull();
    expect(refillRecencyLine({ fillSize: -30, atMs: at }, at)).toBeNull();
    expect(refillRecencyLine({ fillSize: NaN, atMs: at }, at)).toBeNull();
  });

  it("still reads as just-now when the clock moved backwards", () => {
    expect(refillRecencyLine({ fillSize: 30, atMs: at }, at - 5_000)).toBe(
      "Refilled just now (+30)"
    );
  });
});

describe("refillRecencyExpiryMs (#1893)", () => {
  const at = 1_700_000_000_000;

  it("is null when nothing is showing", () => {
    expect(refillRecencyExpiryMs(null, at)).toBeNull();
    expect(
      refillRecencyExpiryMs(
        { fillSize: 90, atMs: at },
        at + REFILL_RECENCY_WINDOW_MS
      )
    ).toBeNull();
  });

  it("is the remaining window while the line is showing", () => {
    expect(refillRecencyExpiryMs({ fillSize: 90, atMs: at }, at)).toBe(
      REFILL_RECENCY_WINDOW_MS
    );
    expect(refillRecencyExpiryMs({ fillSize: 90, atMs: at }, at + 30_000)).toBe(
      REFILL_RECENCY_WINDOW_MS - 30_000
    );
  });
});
