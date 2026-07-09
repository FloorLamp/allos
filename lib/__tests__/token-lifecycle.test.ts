import { describe, expect, it } from "vitest";
import {
  expiresAtFromChoice,
  isRotationDue,
  isTokenExpired,
  isValidExpiryChoice,
  parseTokenTimestamp,
  shouldRecordUse,
  tokenLifecycleStatus,
  TOKEN_LAST_USED_THROTTLE_MS,
  TOKEN_ROTATION_NUDGE_MS,
} from "../token-lifecycle";

const NOW = Date.parse("2026-07-09T12:00:00Z");

describe("isValidExpiryChoice", () => {
  it("accepts the three choices and rejects anything else", () => {
    expect(isValidExpiryChoice("never")).toBe(true);
    expect(isValidExpiryChoice("90d")).toBe(true);
    expect(isValidExpiryChoice("1y")).toBe(true);
    expect(isValidExpiryChoice("30d")).toBe(false);
    expect(isValidExpiryChoice("")).toBe(false);
    expect(isValidExpiryChoice(undefined)).toBe(false);
    expect(isValidExpiryChoice(null)).toBe(false);
  });
});

describe("parseTokenTimestamp", () => {
  it("parses ISO and SQLite UTC forms, rejects junk/absent", () => {
    expect(parseTokenTimestamp("2026-07-09T12:00:00.000Z")).toBe(NOW);
    // SQLite datetime('now') form is treated as UTC (Z appended internally).
    expect(parseTokenTimestamp("2026-07-09 12:00:00")).toBe(NOW);
    expect(parseTokenTimestamp(null)).toBeNull();
    expect(parseTokenTimestamp(undefined)).toBeNull();
    expect(parseTokenTimestamp("")).toBeNull();
    expect(parseTokenTimestamp("not-a-date")).toBeNull();
  });
});

describe("expiresAtFromChoice", () => {
  it("returns null for never and an absolute instant for bounded choices", () => {
    expect(expiresAtFromChoice("never", NOW)).toBeNull();
    const d90 = parseTokenTimestamp(expiresAtFromChoice("90d", NOW))!;
    expect(d90 - NOW).toBe(90 * 24 * 60 * 60 * 1000);
    const d1y = parseTokenTimestamp(expiresAtFromChoice("1y", NOW))!;
    expect(d1y - NOW).toBe(365 * 24 * 60 * 60 * 1000);
  });
});

describe("isTokenExpired", () => {
  it("never expires a null/absent expiry", () => {
    expect(isTokenExpired(null, NOW)).toBe(false);
    expect(isTokenExpired(undefined, NOW)).toBe(false);
    expect(isTokenExpired("", NOW)).toBe(false);
  });
  it("expires at or after the instant, not before", () => {
    const future = new Date(NOW + 1000).toISOString();
    const past = new Date(NOW - 1000).toISOString();
    expect(isTokenExpired(future, NOW)).toBe(false);
    expect(isTokenExpired(past, NOW)).toBe(true);
    // Exactly at the boundary counts as expired.
    expect(isTokenExpired(new Date(NOW).toISOString(), NOW)).toBe(true);
  });
});

describe("shouldRecordUse", () => {
  it("writes when never used or older than the throttle window", () => {
    expect(shouldRecordUse(null, NOW)).toBe(true);
    const stale = new Date(NOW - TOKEN_LAST_USED_THROTTLE_MS - 1).toISOString();
    expect(shouldRecordUse(stale, NOW)).toBe(true);
    // Exactly at the window boundary writes.
    const boundary = new Date(NOW - TOKEN_LAST_USED_THROTTLE_MS).toISOString();
    expect(shouldRecordUse(boundary, NOW)).toBe(true);
  });
  it("skips when used within the throttle window", () => {
    const recent = new Date(NOW - 60_000).toISOString();
    expect(shouldRecordUse(recent, NOW)).toBe(false);
  });
});

describe("isRotationDue", () => {
  it("is due once older than ~1 year, not before", () => {
    expect(isRotationDue(null, NOW)).toBe(false);
    const fresh = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(isRotationDue(fresh, NOW)).toBe(false);
    const old = new Date(NOW - TOKEN_ROTATION_NUDGE_MS - 1).toISOString();
    expect(isRotationDue(old, NOW)).toBe(true);
  });
});

describe("tokenLifecycleStatus", () => {
  it("returns none when there is no token", () => {
    expect(tokenLifecycleStatus({ hasToken: false }, NOW)).toBe("none");
  });
  it("prioritises expired over rotate", () => {
    const old = new Date(NOW - TOKEN_ROTATION_NUDGE_MS - 1).toISOString();
    const expired = new Date(NOW - 1000).toISOString();
    expect(
      tokenLifecycleStatus(
        { hasToken: true, createdAt: old, expiresAt: expired },
        NOW
      )
    ).toBe("expired");
  });
  it("flags rotate for an old but unexpired token", () => {
    const old = new Date(NOW - TOKEN_ROTATION_NUDGE_MS - 1).toISOString();
    expect(tokenLifecycleStatus({ hasToken: true, createdAt: old }, NOW)).toBe(
      "rotate"
    );
  });
  it("is active for a fresh token", () => {
    const fresh = new Date(NOW - 1000).toISOString();
    expect(
      tokenLifecycleStatus({ hasToken: true, createdAt: fresh }, NOW)
    ).toBe("active");
  });
});
