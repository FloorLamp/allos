import { describe, expect, it } from "vitest";
import {
  fitnessRetestDue,
  fitnessCheckSignalKey,
  FITNESS_CHECK_PREFIX,
  DEFAULT_FITNESS_RETEST_DAYS,
} from "@/lib/fitness-retest";
import { dedupeKeyHasKnownPrefix, tierForDedupeKey } from "@/lib/rule-finding-prefixes";

// Pure retest-cadence decision (issue #834). No DB.

describe("fitnessRetestDue", () => {
  it("is due once a prior check ages past the cadence", () => {
    const d = fitnessRetestDue("2026-01-01", 90, "2026-04-15"); // 104 days
    expect(d.due).toBe(true);
    expect(d.daysSince).toBe(104);
    expect(d.lastDate).toBe("2026-01-01");
  });

  it("is not due within the cadence window", () => {
    const d = fitnessRetestDue("2026-01-01", 90, "2026-02-15"); // 45 days
    expect(d.due).toBe(false);
  });

  it("is exactly due at the cadence boundary", () => {
    const d = fitnessRetestDue("2026-01-01", 90, "2026-04-01"); // 90 days
    expect(d.due).toBe(true);
  });

  it("never nags a subject who has never done a check (calm baseline restraint)", () => {
    const d = fitnessRetestDue(null, 90, "2026-04-15");
    expect(d.due).toBe(false);
    expect(d.lastDate).toBeNull();
    expect(d.daysSince).toBeNull();
  });

  it("refuses a non-positive cadence", () => {
    expect(fitnessRetestDue("2026-01-01", 0, "2026-06-01").due).toBe(false);
  });
});

describe("dedupeKey", () => {
  it("re-keys by the last-check date and registers under the known coaching prefix", () => {
    const key = fitnessCheckSignalKey("2026-03-12");
    expect(key).toBe(`${FITNESS_CHECK_PREFIX}retest:2026-03-12`);
    expect(dedupeKeyHasKnownPrefix(key)).toBe(true);
    expect(tierForDedupeKey(key)).toBe("coaching");
  });

  it("has a sensible default cadence (~quarterly)", () => {
    expect(DEFAULT_FITNESS_RETEST_DAYS).toBe(90);
  });
});
