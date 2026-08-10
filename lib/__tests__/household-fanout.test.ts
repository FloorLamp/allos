// The dashboard's cross-profile work is BOUNDED (#2432 follow-up): an admin
// reaches every profile on the instance, and both the household strip and the
// illness accordion do an expensive per-profile read. Measured on the e2e
// template's 180 profiles, that fan-out was ~90% of the dashboard's server
// render. These pin the bound's shape, and the fact that it is a bound at all.
import { describe, it, expect } from "vitest";
import {
  HOUSEHOLD_FANOUT_LIMIT,
  householdFanoutProfiles,
} from "../household-fanout";

const profiles = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

describe("household fan-out bound", () => {
  it("excludes the acting profile", () => {
    const out = householdFanoutProfiles(profiles(4), 2);
    expect(out.map((p) => p.id)).toEqual([1, 3, 4]);
  });

  it("returns a real household untouched", () => {
    // The bound must never bite a family. Eight members plus the acting one is
    // a large multi-generational household and still passes through whole.
    const out = householdFanoutProfiles(profiles(9), 1);
    expect(out).toHaveLength(8);
  });

  it("bounds an instance-sized set", () => {
    // The case that motivated this: an admin reaching every profile.
    const out = householdFanoutProfiles(profiles(180), 1);
    expect(out).toHaveLength(HOUSEHOLD_FANOUT_LIMIT);
  });

  it("takes the lowest ids, so two renders agree", () => {
    // accessibleProfiles is ORDER BY p.id, so slicing is stable rather than
    // arbitrary — a chip cannot appear and vanish between two renders of the
    // same session.
    const out = householdFanoutProfiles(profiles(180), 1);
    expect(out.map((p) => p.id)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
  });

  it("keeps the bound generous enough to be invisible to a household", () => {
    // A tripwire on the VALUE, not just the mechanism: shrinking this toward a
    // handful would start hiding real members from the strip, which is a
    // product decision and not a performance one.
    expect(HOUSEHOLD_FANOUT_LIMIT).toBeGreaterThanOrEqual(8);
  });

  it("treats a nonsense limit as empty rather than negative-slicing", () => {
    // .slice(0, -1) would silently drop the LAST entry instead of returning
    // nothing, which is the kind of quiet wrong answer this guards against.
    expect(householdFanoutProfiles(profiles(5), 1, -3)).toEqual([]);
  });
});
