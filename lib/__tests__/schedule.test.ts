import { describe, expect, it } from "vitest";
import { slotDue } from "@/lib/notifications/schedule";

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
