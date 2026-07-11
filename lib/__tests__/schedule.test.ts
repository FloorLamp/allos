import { describe, expect, it } from "vitest";
import {
  slotDue,
  inWakingWindow,
  WAKING_START_HOUR,
  WAKING_END_HOUR,
} from "@/lib/notifications/schedule";

describe("slotDue", () => {
  it("is due at the slot's exact hour", () => {
    expect(slotDue(8, 8)).toBe(true);
  });

  it("is also due one hour later (DST-skip / failed-send retry window)", () => {
    expect(slotDue(8, 9)).toBe(true);
  });

  it("is not due outside the [slot, slot+1] window", () => {
    expect(slotDue(8, 7)).toBe(false);
    expect(slotDue(8, 10)).toBe(false);
  });

  it("does not wrap the retry hour past midnight (next day = fresh dedup key)", () => {
    expect(slotDue(23, 23)).toBe(true);
    expect(slotDue(23, 0)).toBe(false);
    expect(slotDue(23, 22)).toBe(false);
  });
});

describe("inWakingWindow", () => {
  it("holds the episode nudges out at the local-midnight rollover and the 1-3am hours (#378)", () => {
    expect(inWakingWindow(0)).toBe(false);
    expect(inWakingWindow(1)).toBe(false);
    expect(inWakingWindow(3)).toBe(false);
  });

  it("is inclusive of both window boundaries", () => {
    expect(inWakingWindow(WAKING_START_HOUR)).toBe(true); // 8:00
    expect(inWakingWindow(WAKING_END_HOUR)).toBe(true); // 21:xx
  });

  it("rejects the hours just outside each boundary", () => {
    expect(inWakingWindow(WAKING_START_HOUR - 1)).toBe(false); // 7:xx
    expect(inWakingWindow(WAKING_END_HOUR + 1)).toBe(false); // 22:xx
  });

  it("is open across the daytime hours", () => {
    for (let h = WAKING_START_HOUR; h <= WAKING_END_HOUR; h++) {
      expect(inWakingWindow(h)).toBe(true);
    }
  });

  it("accepts an overridden window", () => {
    expect(inWakingWindow(7, 6, 22)).toBe(true);
    expect(inWakingWindow(5, 6, 22)).toBe(false);
  });
});
