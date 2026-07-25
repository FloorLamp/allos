import { describe, expect, it } from "vitest";
import {
  FREEZE_HAZARD_MINUTES,
  isNearUtcMidnight,
  minutesToUtcMidnight,
  resolveFreezeInstant,
} from "@/lib/e2e-freeze-instant";

// The e2e suite's freeze-instant guard (issue #1464 part A). The suite freezes
// ALLOS_TEST_NOW at its real start; a run beginning just before midnight then spends
// the rest of itself writing SQL-`now()`-stamped rows dated TOMORROW while the frozen
// today() still says YESTERDAY. This picks which side of the boundary the frozen date
// lands on — see the module header for why forward is the only direction that helps.

const at = (iso: string) => new Date(iso);

describe("minutesToUtcMidnight", () => {
  it("measures the gap to the NEXT UTC midnight", () => {
    expect(minutesToUtcMidnight(at("2026-07-24T23:57:00.000Z"))).toBe(3);
    expect(minutesToUtcMidnight(at("2026-07-24T12:00:00.000Z"))).toBe(720);
    // Exactly midnight is a full day from the NEXT one, never 0.
    expect(minutesToUtcMidnight(at("2026-07-24T00:00:00.000Z"))).toBe(1440);
  });
});

describe("isNearUtcMidnight", () => {
  it("flags the last half hour of the UTC day", () => {
    expect(isNearUtcMidnight(at("2026-07-24T23:57:28.000Z"))).toBe(true);
    expect(isNearUtcMidnight(at("2026-07-24T23:30:00.000Z"))).toBe(true);
  });

  it("leaves every other hour alone — including just AFTER midnight", () => {
    expect(isNearUtcMidnight(at("2026-07-24T23:29:59.000Z"))).toBe(false);
    // Past the boundary the frozen date already matches what runtime rows will carry.
    expect(isNearUtcMidnight(at("2026-07-25T00:01:00.000Z"))).toBe(false);
    expect(isNearUtcMidnight(at("2026-07-25T02:29:47.000Z"))).toBe(false);
    expect(isNearUtcMidnight(at("2026-07-24T12:00:00.000Z"))).toBe(false);
  });
});

describe("resolveFreezeInstant", () => {
  it("returns the real start untouched outside the hazard window", () => {
    // The #1048 property: |real − frozen| stays within the suite's own duration.
    for (const iso of [
      "2026-07-24T12:00:00.000Z",
      "2026-07-24T23:29:00.000Z",
      "2026-07-25T00:30:00.000Z",
      "2026-07-25T02:29:47.000Z",
    ]) {
      expect(resolveFreezeInstant(at(iso)).toISOString()).toBe(iso);
    }
  });

  it("nudges FORWARD across midnight inside the hazard window", () => {
    // #1452's red run started here.
    expect(
      resolveFreezeInstant(at("2026-07-24T23:57:28.000Z")).toISOString()
    ).toBe("2026-07-25T00:30:00.000Z");
    expect(
      resolveFreezeInstant(at("2026-07-24T23:31:00.000Z")).toISOString()
    ).toBe("2026-07-25T00:30:00.000Z");
  });

  it("never nudges BACKWARD — that would widen the very gap it closes", () => {
    const start = at("2026-07-24T23:57:28.000Z");
    expect(resolveFreezeInstant(start).getTime()).toBeGreaterThan(
      start.getTime()
    );
  });

  it("lands the nudged instant on the day the run will spend its time in", () => {
    const resolved = resolveFreezeInstant(at("2026-07-24T23:57:28.000Z"));
    expect(resolved.toISOString().slice(0, 10)).toBe("2026-07-25");
    // …and far enough past midnight that a slow seed + boot can't drift back over it.
    expect(minutesToUtcMidnight(resolved)).toBeLessThan(1440);
    expect(resolved.getUTCHours()).toBe(0);
    expect(resolved.getUTCMinutes()).toBe(30);
  });

  it("crosses month and year boundaries correctly", () => {
    expect(
      resolveFreezeInstant(at("2026-07-31T23:50:00.000Z")).toISOString()
    ).toBe("2026-08-01T00:30:00.000Z");
    expect(
      resolveFreezeInstant(at("2026-12-31T23:50:00.000Z")).toISOString()
    ).toBe("2027-01-01T00:30:00.000Z");
  });

  it("honors a caller-supplied hazard width", () => {
    const start = at("2026-07-24T23:20:00.000Z");
    expect(resolveFreezeInstant(start, FREEZE_HAZARD_MINUTES)).toBe(start);
    expect(resolveFreezeInstant(start, 60).toISOString()).toBe(
      "2026-07-25T00:30:00.000Z"
    );
  });
});
