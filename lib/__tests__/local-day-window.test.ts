import { describe, expect, it } from "vitest";
import {
  localDayOf,
  localDayRange,
  localDaySpan,
  offsetModifier,
  offsetSegments,
} from "../local-day-window";

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
