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

  // #450 — per-profile quiet hours, incl. a night-shift window that wraps midnight.
  it("supports a wrapped (overnight) window for a night-shift rhythm (#450)", () => {
    // Awake 20:00 → 08:00 (start > end): the daytime hours are the QUIET ones.
    expect(inWakingWindow(20, 20, 8)).toBe(true); // start boundary
    expect(inWakingWindow(23, 20, 8)).toBe(true); // late night
    expect(inWakingWindow(0, 20, 8)).toBe(true); // past midnight
    expect(inWakingWindow(8, 20, 8)).toBe(true); // end boundary
    expect(inWakingWindow(9, 20, 8)).toBe(false); // into the quiet daytime
    expect(inWakingWindow(12, 20, 8)).toBe(false); // midday quiet
    expect(inWakingWindow(19, 20, 8)).toBe(false); // just before waking
  });

  it("treats a full 0→23 window as always waking (no quiet hours)", () => {
    for (let h = 0; h <= 23; h++) expect(inWakingWindow(h, 0, 23)).toBe(true);
  });

  it("treats a same start/end as a literal one-hour window", () => {
    expect(inWakingWindow(9, 9, 9)).toBe(true);
    expect(inWakingWindow(10, 9, 9)).toBe(false);
  });
});
