import { describe, it, expect } from "vitest";
import {
  REPLAYED_KEYS_RETENTION_DAYS,
  DEFAULT_AUDIT_RETENTION_MONTHS,
  MIN_AUDIT_RETENTION_MONTHS,
  MAX_AUDIT_RETENTION_MONTHS,
  clampAuditRetentionMonths,
  DEFAULT_TRASH_RETENTION_DAYS,
  MIN_TRASH_RETENTION_DAYS,
  MAX_TRASH_RETENTION_DAYS,
  clampTrashRetentionDays,
  daysAgoModifier,
  monthsAgoModifier,
  cutoffDaysAgo,
  isExpired,
} from "@/lib/retention";

// Pure retention-window math for the notify-tick sweeps (issue #98). The DB DELETEs
// are covered separately in the DB tier (lib/__db_tests__/retention-sweeps.test.ts).

describe("retention windows", () => {
  it("keeps replayed_keys for a week and audits generously by default", () => {
    expect(REPLAYED_KEYS_RETENTION_DAYS).toBe(7);
    expect(DEFAULT_AUDIT_RETENTION_MONTHS).toBe(24);
    expect(DEFAULT_AUDIT_RETENTION_MONTHS).toBeGreaterThanOrEqual(
      MIN_AUDIT_RETENTION_MONTHS
    );
    expect(DEFAULT_AUDIT_RETENTION_MONTHS).toBeLessThanOrEqual(
      MAX_AUDIT_RETENTION_MONTHS
    );
  });
});

describe("clampAuditRetentionMonths", () => {
  it("passes an in-range whole month through unchanged", () => {
    expect(clampAuditRetentionMonths(12)).toBe(12);
    expect(clampAuditRetentionMonths(36)).toBe(36);
  });

  it("rounds a fractional month", () => {
    expect(clampAuditRetentionMonths(11.4)).toBe(11);
    expect(clampAuditRetentionMonths(11.6)).toBe(12);
  });

  it("clamps below the floor and above the ceiling", () => {
    expect(clampAuditRetentionMonths(0)).toBe(MIN_AUDIT_RETENTION_MONTHS);
    expect(clampAuditRetentionMonths(-5)).toBe(MIN_AUDIT_RETENTION_MONTHS);
    expect(clampAuditRetentionMonths(9_999)).toBe(MAX_AUDIT_RETENTION_MONTHS);
  });

  it("holds exactly at the boundaries", () => {
    expect(clampAuditRetentionMonths(MIN_AUDIT_RETENTION_MONTHS)).toBe(
      MIN_AUDIT_RETENTION_MONTHS
    );
    expect(clampAuditRetentionMonths(MAX_AUDIT_RETENTION_MONTHS)).toBe(
      MAX_AUDIT_RETENTION_MONTHS
    );
  });

  it("falls back to the default on garbage input", () => {
    expect(clampAuditRetentionMonths(NaN)).toBe(DEFAULT_AUDIT_RETENTION_MONTHS);
    expect(clampAuditRetentionMonths(Infinity)).toBe(
      DEFAULT_AUDIT_RETENTION_MONTHS
    );
  });
});

// Trash retention (#2013) — the same shape as audit retention one window over, in
// whole DAYS. The window is what makes a Trash worth opening, so its clamp gets the
// same floor/ceiling/garbage treatment.
describe("clampTrashRetentionDays", () => {
  it("passes an in-range whole day through unchanged", () => {
    expect(clampTrashRetentionDays(30)).toBe(30);
    expect(clampTrashRetentionDays(7)).toBe(7);
  });

  it("rounds a fractional day", () => {
    expect(clampTrashRetentionDays(29.4)).toBe(29);
    expect(clampTrashRetentionDays(29.6)).toBe(30);
  });

  it("clamps below the floor and above the ceiling", () => {
    expect(clampTrashRetentionDays(0)).toBe(MIN_TRASH_RETENTION_DAYS);
    expect(clampTrashRetentionDays(-5)).toBe(MIN_TRASH_RETENTION_DAYS);
    expect(clampTrashRetentionDays(9_999)).toBe(MAX_TRASH_RETENTION_DAYS);
  });

  it("holds exactly at the boundaries", () => {
    expect(clampTrashRetentionDays(MIN_TRASH_RETENTION_DAYS)).toBe(
      MIN_TRASH_RETENTION_DAYS
    );
    expect(clampTrashRetentionDays(MAX_TRASH_RETENTION_DAYS)).toBe(
      MAX_TRASH_RETENTION_DAYS
    );
  });

  it("falls back to the default on garbage input", () => {
    // The read path does clampTrashRetentionDays(Number(raw)), so an ABSENT key
    // arrives as NaN — the common case, not an edge one.
    expect(clampTrashRetentionDays(Number(undefined))).toBe(
      DEFAULT_TRASH_RETENTION_DAYS
    );
    expect(clampTrashRetentionDays(NaN)).toBe(DEFAULT_TRASH_RETENTION_DAYS);
    expect(clampTrashRetentionDays(Infinity)).toBe(
      DEFAULT_TRASH_RETENTION_DAYS
    );
  });

  it("keeps the default inside its own range", () => {
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBeGreaterThanOrEqual(
      MIN_TRASH_RETENTION_DAYS
    );
    expect(DEFAULT_TRASH_RETENTION_DAYS).toBeLessThanOrEqual(
      MAX_TRASH_RETENTION_DAYS
    );
  });
});

describe("SQLite age modifiers", () => {
  it("formats day- and month-based modifiers for datetime('now', ?)", () => {
    expect(daysAgoModifier(REPLAYED_KEYS_RETENTION_DAYS)).toBe("-7 days");
    // The Trash sweep binds this same modifier (#2013) — the window is DAYS, so the
    // sweep's cutoff and the setting are the same number with no conversion between.
    expect(daysAgoModifier(DEFAULT_TRASH_RETENTION_DAYS)).toBe("-30 days");
    expect(monthsAgoModifier(24)).toBe("-24 months");
  });
});

describe("isExpired (cutoff boundary)", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const cutoff = cutoffDaysAgo(now, REPLAYED_KEYS_RETENTION_DAYS);

  it("places the cutoff exactly one window before now", () => {
    expect(cutoff.toISOString()).toBe("2026-07-03T12:00:00.000Z");
  });

  it("keeps a row exactly at the cutoff edge (strictly-older only)", () => {
    expect(isExpired(cutoff, cutoff)).toBe(false);
  });

  it("expires a row one millisecond older than the cutoff", () => {
    expect(isExpired(new Date(cutoff.getTime() - 1), cutoff)).toBe(true);
  });

  it("keeps a row one millisecond newer than the cutoff", () => {
    expect(isExpired(new Date(cutoff.getTime() + 1), cutoff)).toBe(false);
  });

  it("keeps a fresh row and expires an ancient one", () => {
    expect(isExpired(now, cutoff)).toBe(false);
    expect(isExpired(new Date("2020-01-01T00:00:00.000Z"), cutoff)).toBe(true);
  });
});
