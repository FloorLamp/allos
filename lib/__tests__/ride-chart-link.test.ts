import { describe, expect, it } from "vitest";
import {
  nearestRideElapsedIndex,
  rideElapsedSeconds,
} from "@/lib/ride-chart-link";

describe("ride chart linking", () => {
  it("parses both minute and hour elapsed labels", () => {
    expect(rideElapsedSeconds("12:30")).toBe(750);
    expect(rideElapsedSeconds("1:02:03")).toBe(3723);
    expect(rideElapsedSeconds("bad")).toBeNull();
  });

  it("snaps unlike sampling rates to the nearest elapsed point", () => {
    expect(nearestRideElapsedIndex(["0:00", "1:00", "2:00"], "1:22")).toBe(1);
    expect(nearestRideElapsedIndex(["0:03", "0:59", "2:01"], "1:00")).toBe(1);
  });
});
