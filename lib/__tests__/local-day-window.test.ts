import { describe, expect, it } from "vitest";
import {
  localDayOf,
  localDayRange,
  localDaySpan,
  localMinuteProjector,
  offsetModifier,
  offsetSegments,
} from "../local-day-window";
import { zonedMinuteStr } from "../date";

// The read-time day attribution behind the hr_minutes conversion (#2205 / #94).
// These pin the two properties the SQL depends on: a local day maps to the RIGHT
// half-open UTC range even when that day is 23 or 25 hours long, and a window splits
// exactly at a DST transition so `date(ts, modifier)` is exact inside each piece.

const NY = "America/New_York";
const KTM = "Asia/Kathmandu"; // +05:45 — the reason the modifier carries minutes
const UTC = "UTC";

describe("offsetModifier", () => {
  it("renders whole-hour and fractional-hour zones the way SQLite reads them", () => {
    expect(offsetModifier(-300)).toBe("-05:00");
    expect(offsetModifier(-240)).toBe("-04:00");
    expect(offsetModifier(345)).toBe("+05:45");
    expect(offsetModifier(0)).toBe("+00:00");
    expect(offsetModifier(-30)).toBe("-00:30");
  });
});

describe("localDayRange", () => {
  it("covers an ordinary 24-hour day", () => {
    expect(localDayRange(NY, "2026-01-15")).toEqual({
      startUtc: "2026-01-15T05:00:00Z",
      endUtc: "2026-01-16T05:00:00Z",
    });
  });

  it("covers a 23-hour spring-forward day", () => {
    // 2026-03-08: NY jumps 02:00 → 03:00, so the local day is 23 hours.
    const { startUtc, endUtc } = localDayRange(NY, "2026-03-08");
    expect(startUtc).toBe("2026-03-08T05:00:00Z");
    expect(endUtc).toBe("2026-03-09T04:00:00Z");
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(23 * 3_600_000);
  });

  it("covers a 25-hour fall-back day", () => {
    // 2026-11-01: NY repeats 01:00-01:59, so the local day is 25 hours.
    const { startUtc, endUtc } = localDayRange(NY, "2026-11-01");
    expect(Date.parse(endUtc) - Date.parse(startUtc)).toBe(25 * 3_600_000);
  });

  it("handles a fractional-offset zone", () => {
    expect(localDayRange(KTM, "2026-01-15")).toEqual({
      startUtc: "2026-01-14T18:15:00Z",
      endUtc: "2026-01-15T18:15:00Z",
    });
  });

  it("is identity-shaped in UTC", () => {
    expect(localDayRange(UTC, "2026-01-15")).toEqual({
      startUtc: "2026-01-15T00:00:00Z",
      endUtc: "2026-01-16T00:00:00Z",
    });
  });
});

describe("localDaySpan", () => {
  it("spans inclusive local days as a half-open UTC range", () => {
    expect(localDaySpan(NY, "2026-01-15", "2026-01-17")).toEqual({
      startUtc: "2026-01-15T05:00:00Z",
      endUtc: "2026-01-18T05:00:00Z",
    });
  });

  it("absorbs a DST change inside the span", () => {
    const { startUtc, endUtc } = localDaySpan(NY, "2026-03-07", "2026-03-09");
    expect(startUtc).toBe("2026-03-07T05:00:00Z");
    // The far edge is settled at the POST-transition offset, not the near one.
    expect(endUtc).toBe("2026-03-10T04:00:00Z");
  });
});

describe("offsetSegments", () => {
  it("returns ONE segment for a window with no transition — the common case", () => {
    const segs = offsetSegments(
      NY,
      "2026-01-01T05:00:00Z",
      "2026-02-01T05:00:00Z"
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].modifier).toBe("-05:00");
    expect(segs[0].startUtc).toBe("2026-01-01T05:00:00Z");
    expect(segs[0].endUtc).toBe("2026-02-01T05:00:00Z");
  });

  it("splits exactly at the spring-forward transition", () => {
    const segs = offsetSegments(
      NY,
      "2026-03-07T05:00:00Z",
      "2026-03-10T04:00:00Z"
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].modifier).toBe("-05:00");
    expect(segs[1].modifier).toBe("-04:00");
    // NY springs forward at 07:00 UTC on 2026-03-08.
    expect(segs[0].endUtc).toBe("2026-03-08T07:00:00Z");
    expect(segs[1].startUtc).toBe("2026-03-08T07:00:00Z");
    // Contiguous and gapless — no minute belongs to two segments or to none.
    expect(segs[0].endUtc).toBe(segs[1].startUtc);
  });

  it("splits exactly at the fall-back transition", () => {
    const segs = offsetSegments(
      NY,
      "2026-10-31T04:00:00Z",
      "2026-11-02T05:00:00Z"
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].modifier).toBe("-04:00");
    expect(segs[1].modifier).toBe("-05:00");
    expect(segs[0].endUtc).toBe("2026-11-01T06:00:00Z");
  });

  it("splits a window that spans both of a year's transitions", () => {
    const segs = offsetSegments(
      NY,
      "2026-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z"
    );
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.modifier)).toEqual(["-05:00", "-04:00", "-05:00"]);
    // Still contiguous end-to-end.
    expect(segs[0].endUtc).toBe(segs[1].startUtc);
    expect(segs[1].endUtc).toBe(segs[2].startUtc);
    expect(segs[2].endUtc).toBe("2027-01-01T00:00:00Z");
  });

  it("never splits a zone that has no DST at all", () => {
    const segs = offsetSegments(
      "Asia/Kolkata",
      "2020-01-01T00:00:00Z",
      "2027-01-01T00:00:00Z"
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].modifier).toBe("+05:30");
  });

  it("returns nothing for an empty or inverted window", () => {
    expect(
      offsetSegments(NY, "2026-01-02T00:00:00Z", "2026-01-02T00:00:00Z")
    ).toEqual([]);
    expect(
      offsetSegments(NY, "2026-01-03T00:00:00Z", "2026-01-02T00:00:00Z")
    ).toEqual([]);
  });

  it("stays bounded rather than issuing unbounded queries on an absurd window", () => {
    // Twenty years straddles ~40 transitions; the valve caps the split and hands the
    // remainder back as one segment, still contiguous and still covering the window.
    const segs = offsetSegments(
      NY,
      "2006-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      4
    );
    expect(segs.length).toBeLessThanOrEqual(4);
    expect(segs[0].startUtc).toBe("2006-01-01T00:00:00Z");
    expect(segs[segs.length - 1].endUtc).toBe("2026-01-01T00:00:00Z");
    for (let i = 1; i < segs.length; i++)
      expect(segs[i - 1].endUtc).toBe(segs[i].startUtc);
  });
});

describe("localDayOf", () => {
  it("attributes an instant to the profile-local day, not the UTC one", () => {
    // 03:30 UTC is still the previous evening in New York.
    expect(localDayOf(NY, "2026-01-16T03:30:00Z")).toBe("2026-01-15");
    expect(localDayOf(UTC, "2026-01-16T03:30:00Z")).toBe("2026-01-16");
  });

  it("agrees with localDayRange at both edges of a DST day", () => {
    const { startUtc, endUtc } = localDayRange(NY, "2026-03-08");
    expect(localDayOf(NY, startUtc)).toBe("2026-03-08");
    // The exclusive end belongs to the NEXT day — that is what half-open means.
    expect(localDayOf(NY, endUtc)).toBe("2026-03-09");
    const lastMinute = new Date(Date.parse(endUtc) - 60_000).toISOString();
    expect(localDayOf(NY, lastMinute)).toBe("2026-03-08");
  });

  it("is null on an unparseable stamp rather than guessing a day", () => {
    expect(localDayOf(NY, "not-a-time")).toBeNull();
  });
});

// ---- localMinuteProjector: the arithmetic must BE the Intl answer (#5010) ----
//
// The projector replaces ~350,000 per-render `formatToParts` calls with addition, and
// the only thing that makes that safe is that the two agree EXACTLY. So the guard is
// equivalence against `zonedMinuteStr` itself — the function it replaces — swept minute
// by minute ACROSS each boundary rather than sampled inside a segment, because a wrong
// offset derivation is invisible mid-segment and only shows at the seam.
describe("localMinuteProjector — equivalence with the per-row Intl projection", () => {
  // Every minute of a 3-day span centred on the seam, so the sweep contains the
  // transition instant itself, the repeated hour, and the skipped hour.
  const sweep = (tz: string, fromUtc: string, hours: number) => {
    const start = Date.parse(fromUtc);
    const endUtc =
      new Date(start + hours * 3_600_000).toISOString().slice(0, 19) + "Z";
    const project = localMinuteProjector(tz, fromUtc, endUtc);
    const disagreements: string[] = [];
    for (let m = 0; m < hours * 60; m++) {
      const at = new Date(start + m * 60_000);
      const ts = at.toISOString().slice(0, 19) + "Z";
      const arithmetic = project(ts);
      const intl = zonedMinuteStr(tz, at);
      if (arithmetic !== intl)
        disagreements.push(`${ts}: ${arithmetic} != ${intl}`);
    }
    return disagreements;
  };

  // Both DST directions, a 30-minute DST step, two non-hour standard offsets, and a
  // zone that never transitions — the offset shapes the arithmetic has to survive.
  it.each([
    [
      "America/New_York spring forward",
      "America/New_York",
      "2026-03-07T00:00:00Z",
      72,
    ],
    [
      "America/New_York fall back",
      "America/New_York",
      "2026-10-31T00:00:00Z",
      72,
    ],
    [
      "Australia/Lord_Howe 30-minute step",
      "Australia/Lord_Howe",
      "2026-04-03T00:00:00Z",
      72,
    ],
    [
      "Pacific/Chatham +12:45/+13:45",
      "Pacific/Chatham",
      "2026-04-03T00:00:00Z",
      72,
    ],
    [
      "Asia/Kathmandu +05:45, no transition",
      "Asia/Kathmandu",
      "2026-03-07T00:00:00Z",
      72,
    ],
    ["UTC", "UTC", "2026-03-07T00:00:00Z", 72],
  ])("agrees every minute across %s", (_label, tz, fromUtc, hours) => {
    expect(sweep(tz, fromUtc, hours as number)).toEqual([]);
  });

  // The seam itself, named rather than left to the sweep: a row stamped at the exact
  // transition instant must read the INCOMING offset. This is the case a segment cut
  // that is even one second late gets wrong, and the sweep would report it as one line
  // among 4320 — so it is asserted on its own.
  it("dates the row ON the transition instant under the offset that just began", () => {
    const project = localMinuteProjector(
      "America/New_York",
      "2026-03-07T00:00:00Z",
      "2026-03-10T00:00:00Z"
    );
    // 07:00Z is the instant EST(-05:00) becomes EDT(-04:00): 02:00 becomes 03:00.
    expect(project("2026-03-08T06:59:00Z")).toBe("2026-03-08T01:59");
    expect(project("2026-03-08T07:00:00Z")).toBe("2026-03-08T03:00");
    expect(
      zonedMinuteStr("America/New_York", new Date("2026-03-08T07:00:00Z"))
    ).toBe("2026-03-08T03:00");
  });

  // A travel switch moves the profile's zone, and this reader projects a whole span
  // through ONE zone (the current one) — so a switch does not segment the span, it
  // re-reads it. Both sides must equal the per-row projection under that same zone,
  // which is what keeps #3428's "zone resolved at the instant" honesty unchanged.
  it("re-reads a span identically under each side of a travel switch", () => {
    for (const tz of ["Asia/Tokyo", "Pacific/Honolulu"]) {
      expect(sweep(tz, "2026-05-01T00:00:00Z", 48)).toEqual([]);
    }
  });

  // The row loop reads the stamp by CHARACTER INDEX (#5061) rather than through
  // `Date`, so every shape an instant column actually holds — and every shape that
  // only looks like one — has to come out where the `Date` path put it. A stamp whose
  // calendar date does not exist reaches the memo, not the arithmetic, and is the case
  // an index-reading loop would otherwise date rather than refuse.
  it.each([
    ["canonical", "2026-03-08T06:59:00Z", "2026-03-08T01:59"],
    ["SQLite datetime()", "2026-03-08 06:59:00", "2026-03-08T01:59"],
    ["minute only, no zone", "2026-03-08T06:59", "2026-03-08T01:59"],
    [
      "a minute that rolls back a day",
      "2026-03-08T02:30:00Z",
      "2026-03-07T21:30",
    ],
    ["not an instant at all", "not-an-instant", null],
    // `Date` rolls this one over to 2026-03-02 and always has; the arithmetic must
    // roll it over too rather than dating the row from the characters it read.
    [
      "a calendar date `Date` rolls over",
      "2026-02-30T06:59:00Z",
      "2026-03-02T01:59",
    ],
    ["an hour that does not exist", "2026-03-08T25:00:00Z", null],
  ])("reads a %s stamp as %s", (_label, ts, expected) => {
    const project = localMinuteProjector(
      NY,
      "2026-03-01T05:00:00Z",
      "2026-03-15T04:00:00Z"
    );
    expect(project(ts)).toBe(expected);
  });

  it("returns null for an unparseable stamp rather than dating it", () => {
    const project = localMinuteProjector(
      NY,
      "2026-01-01T05:00:00Z",
      "2026-01-02T05:00:00Z"
    );
    expect(project("not-an-instant")).toBeNull();
  });
});
