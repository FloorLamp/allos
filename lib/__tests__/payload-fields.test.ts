import { describe, expect, it } from "vitest";
import { dayStr, num, str } from "../integrations/payload-fields";

// These three coercers used to be private per-source copies (#4552), where an edit
// reached one vendor. Now one edit reaches six source modules at once, so the
// contracts they share need to be pinned somewhere.
//
// Only the UNPROVEN ones are pinned here. The existing parser tests already fail if
// `num` stops rejecting non-numbers and non-finite values (open-meteo, strava,
// health-connect) or if `dayStr` stops requiring the YYYY-MM-DD shape (withings);
// re-asserting those would be redundant. What no test covered before this file is
// `num`'s ARGUMENT PRECEDENCE and `str`'s TRIMMING — each survived a deliberate
// inversion of the implementation with every suite still green.

describe("num", () => {
  // Sources pass field aliases most-specific-first (e.g. health-connect's bucketed
  // `avg` ahead of the raw name). Taking the last finite value instead of the first
  // would silently prefer the legacy spelling on any record carrying both.
  it("takes the first finite argument, not the last", () => {
    expect(num(1, 2)).toBe(1);
    expect(num(null, 2, 3)).toBe(2);
    expect(num(undefined, "7", 3, 4)).toBe(3);
  });

  it("skips non-finite values rather than stopping at them", () => {
    expect(num(NaN, 5)).toBe(5);
    expect(num(Infinity, 5)).toBe(5);
  });

  it("is null when no argument is a finite number", () => {
    expect(num()).toBeNull();
    expect(num(null, undefined, "3", {})).toBeNull();
  });
});

describe("str", () => {
  // Vendor text arrives padded; the trimmed form is what reaches an external id and a
  // stored label, so an untrimmed read would key two records off " 42" and "42".
  it("returns the trimmed value", () => {
    expect(str("  42  ")).toBe("42");
    expect(str("\tname\n")).toBe("name");
  });

  it("treats blank-after-trim as absent", () => {
    expect(str("   ")).toBeNull();
    expect(str("")).toBeNull();
  });
});

describe("dayStr", () => {
  // dayStr reads through str, so the trim contract has to hold on this path too.
  it("accepts a padded day and rejects a partial one", () => {
    expect(dayStr(" 2026-03-01 ")).toBe("2026-03-01");
    expect(dayStr("2026-03")).toBeNull();
  });
});
