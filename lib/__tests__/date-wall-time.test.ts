import { describe, it, expect } from "vitest";
import {
  tzOffsetMs,
  zonedWallTimeToUtc,
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
