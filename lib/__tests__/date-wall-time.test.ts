import { describe, it, expect } from "vitest";
import {
  isDstTransitionDay,
  localDayMinutes,
  tzOffsetMs,
  zonedWallTimeToUtc,
  zonedWallIsoToUtc,
  utcSqlString,
  parseUtcSql,
  zonedDateParts,
} from "@/lib/date";

describe("tzOffsetMs", () => {
  it("is zero for UTC and negative west of UTC", () => {
    const at = new Date("2026-07-15T12:00:00Z");
    expect(tzOffsetMs("UTC", at)).toBe(0);
    // New York in July is EDT (−4h).
    expect(tzOffsetMs("America/New_York", at)).toBe(-4 * 60 * 60 * 1000);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("turns a local wall time into the correct absolute instant", () => {
    // 16:02 wall time in New York (EDT) == 20:02 UTC.
    const d = zonedWallTimeToUtc("America/New_York", "2026-07-15", "16:02");
    expect(d.toISOString()).toBe("2026-07-15T20:02:00.000Z");
  });
  it("is identity-shaped for UTC", () => {
    const d = zonedWallTimeToUtc("UTC", "2026-07-15", "09:30");
    expect(d.toISOString()).toBe("2026-07-15T09:30:00.000Z");
  });
  it("round-trips through zonedDateParts (the wall time comes back)", () => {
    const tz = "America/Los_Angeles";
    const d = zonedWallTimeToUtc(tz, "2026-12-25", "07:45"); // PST (winter)
    const { date, hhmm } = zonedDateParts(tz, d);
    expect(date).toBe("2026-12-25");
    expect(hhmm).toBe("07:45");
  });
});

describe("zonedWallIsoToUtc", () => {
  const TZ = "America/New_York";

  it("resolves a zoneless vendor wall clock, seconds and millis intact", () => {
    expect(
      zonedWallIsoToUtc(TZ, "2026-07-25T23:14:30.500")?.toISOString()
    ).toBe("2026-07-26T03:14:30.500Z");
    // A minute-precision stamp is equally valid; the seconds are simply zero.
    expect(zonedWallIsoToUtc(TZ, "2026-07-25T23:14")?.toISOString()).toBe(
      "2026-07-26T03:14:00.000Z"
    );
    // Space-separated is the same wall clock in a different punctuation.
    expect(zonedWallIsoToUtc(TZ, "2026-07-25 23:14:30")?.toISOString()).toBe(
      "2026-07-26T03:14:30.000Z"
    );
  });

  it("does NOT depend on the server's timezone", () => {
    const prev = process.env.TZ;
    try {
      const under = (serverTz: string) => {
        process.env.TZ = serverTz;
        return zonedWallIsoToUtc(TZ, "2026-07-25T23:14:30.000")?.toISOString();
      };
      expect(under("UTC")).toBe(under("Asia/Tokyo"));
      expect(under("UTC")).toBe("2026-07-26T03:14:30.000Z");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("settles on the offset in force at the instant, across a DST boundary", () => {
    // US DST ends 2026-11-01. 23:00 on Oct 31 is still EDT (−4); the same clock a
    // week later is EST (−5). A one-pass conversion gets the second one wrong.
    expect(zonedWallIsoToUtc(TZ, "2026-10-31T23:00:00")?.toISOString()).toBe(
      "2026-11-01T03:00:00.000Z"
    );
    expect(zonedWallIsoToUtc(TZ, "2026-11-07T23:00:00")?.toISOString()).toBe(
      "2026-11-08T04:00:00.000Z"
    );
  });

  it("round-trips back to the wall clock it was given", () => {
    const d = zonedWallIsoToUtc(TZ, "2026-12-25T07:45:00")!;
    expect(zonedDateParts(TZ, d)).toMatchObject({
      date: "2026-12-25",
      hhmm: "07:45",
    });
  });

  it("refuses anything that is not a bare wall clock", () => {
    // Already absolute — the caller must decide what to do with it, not receive a
    // second interpretation of a value that already states its own.
    expect(zonedWallIsoToUtc(TZ, "2026-07-25T23:14:30Z")).toBeNull();
    expect(zonedWallIsoToUtc(TZ, "2026-07-25T23:14:30-04:00")).toBeNull();
    expect(zonedWallIsoToUtc(TZ, "2026-07-25")).toBeNull();
    expect(zonedWallIsoToUtc(TZ, "not a timestamp")).toBeNull();
    expect(zonedWallIsoToUtc(TZ, "")).toBeNull();
    // Out-of-range fields would ROLL OVER through Date.UTC into a plausible
    // instant a month or a year away; refusing is the only honest answer.
    expect(zonedWallIsoToUtc(TZ, "2026-13-01T00:00:00")).toBeNull();
    expect(zonedWallIsoToUtc(TZ, "2026-07-25T25:14:00")).toBeNull();
  });
});

describe("utcSqlString / parseUtcSql", () => {
  it("serializes to SQLite's datetime('now') shape and parses back", () => {
    const d = new Date("2026-07-15T20:02:03.000Z");
    expect(utcSqlString(d)).toBe("2026-07-15 20:02:03");
    expect(parseUtcSql("2026-07-15 20:02:03")?.toISOString()).toBe(
      "2026-07-15T20:02:03.000Z"
    );
    // Also accepts an ISO-with-T value and a trailing Z.
    expect(parseUtcSql("2026-07-15T20:02:03Z")?.toISOString()).toBe(
      "2026-07-15T20:02:03.000Z"
    );
  });
  it("returns null for missing/garbage", () => {
    expect(parseUtcSql(null)).toBeNull();
    expect(parseUtcSql("nope")).toBeNull();
  });
});

describe("localDayMinutes / isDstTransitionDay", () => {
  it("measures an ordinary local day as 24 hours", () => {
    expect(localDayMinutes("UTC", "2026-07-15")).toBe(1440);
    expect(localDayMinutes("America/New_York", "2026-07-15")).toBe(1440);
    expect(isDstTransitionDay("America/New_York", "2026-07-15")).toBe(false);
    // A zone with no DST at all never has one.
    expect(isDstTransitionDay("Asia/Tokyo", "2026-03-08")).toBe(false);
  });

  it("finds the two days a year the offset moves, in both hemispheres", () => {
    // US spring forward 2026-03-08 (23h) and fall back 2026-11-01 (25h).
    expect(localDayMinutes("America/New_York", "2026-03-08")).toBe(23 * 60);
    expect(localDayMinutes("America/New_York", "2026-11-01")).toBe(25 * 60);
    expect(isDstTransitionDay("America/New_York", "2026-03-08")).toBe(true);
    expect(isDstTransitionDay("America/New_York", "2026-11-01")).toBe(true);
    // Southern hemisphere, the other way round the year: Sydney 2026-04-05 (25h).
    expect(localDayMinutes("Australia/Sydney", "2026-04-05")).toBe(25 * 60);
    expect(isDstTransitionDay("Australia/Sydney", "2026-04-05")).toBe(true);
    // The days either side are ordinary — the flag marks the seam, not the season.
    expect(isDstTransitionDay("America/New_York", "2026-03-07")).toBe(false);
    expect(isDstTransitionDay("America/New_York", "2026-03-09")).toBe(false);
  });

  it("reports the ordinary day for unparseable input rather than a transition", () => {
    // A caller keying an EXCLUSION on this must drop nothing on a garbage date.
    expect(localDayMinutes("UTC", "not-a-date")).toBe(1440);
    expect(isDstTransitionDay("UTC", "")).toBe(false);
  });
});
