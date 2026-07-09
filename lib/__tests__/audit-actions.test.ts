import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTIONS,
  actionDomain,
  matchesActionPrefix,
  retentionModifier,
  rowsToPrune,
  clampPage,
  pageOffset,
  pageCount,
  DEFAULT_AUDIT_RETENTION_DAYS,
  AUDIT_PAGE_SIZE,
} from "@/lib/audit-actions";

describe("audit action naming", () => {
  it("every action is kebab-case, dotted domain.verb", () => {
    for (const action of Object.values(AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
    }
  });

  it("action names are unique", () => {
    const values = Object.values(AUDIT_ACTIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("actionDomain returns the segment before the first dot", () => {
    expect(actionDomain("login.success")).toBe("login");
    expect(actionDomain("medical-file.view")).toBe("medical-file");
    // No dot → whole string.
    expect(actionDomain("standalone")).toBe("standalone");
    // Only the FIRST dot splits.
    expect(actionDomain("a.b.c")).toBe("a");
  });
});

describe("matchesActionPrefix", () => {
  it("matches an exact action", () => {
    expect(matchesActionPrefix("login.success", "login.success")).toBe(true);
  });

  it("matches any action under a domain prefix", () => {
    expect(matchesActionPrefix("login.success", "login")).toBe(true);
    expect(matchesActionPrefix("login.failure", "login")).toBe(true);
  });

  it("does not match a different domain that merely shares a prefix string", () => {
    // "login" must not match "login-attempt.x" — the boundary is the dot.
    expect(matchesActionPrefix("login-attempt.x", "login")).toBe(false);
    expect(matchesActionPrefix("profile.switch", "login")).toBe(false);
  });

  it("an empty prefix matches everything", () => {
    expect(matchesActionPrefix("anything.here", "")).toBe(true);
  });
});

describe("retention math", () => {
  it("default retention is 90 days", () => {
    expect(DEFAULT_AUDIT_RETENTION_DAYS).toBe(90);
  });

  it("retentionModifier builds the SQLite datetime() age offset", () => {
    expect(retentionModifier(90)).toBe("-90 days");
    expect(retentionModifier(1)).toBe("-1 days");
  });

  it("rowsToPrune keeps newest N and never goes negative", () => {
    expect(rowsToPrune(100, 40)).toBe(60);
    expect(rowsToPrune(40, 40)).toBe(0);
    expect(rowsToPrune(10, 40)).toBe(0); // already under the cap
  });
});

describe("pagination math", () => {
  it("clampPage coerces to a 1-based integer", () => {
    expect(clampPage(1)).toBe(1);
    expect(clampPage(3)).toBe(3);
    expect(clampPage(0)).toBe(1);
    expect(clampPage(-5)).toBe(1);
    expect(clampPage(2.7)).toBe(2);
    expect(clampPage(NaN)).toBe(1);
  });

  it("pageOffset is (page-1)*pageSize on a clamped page", () => {
    expect(pageOffset(1, 50)).toBe(0);
    expect(pageOffset(2, 50)).toBe(50);
    expect(pageOffset(3, 20)).toBe(40);
    expect(pageOffset(0, 50)).toBe(0); // clamped to page 1
  });

  it("pageCount is a ceil, at least 1", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(101, 50)).toBe(3);
  });

  it("default page size", () => {
    expect(AUDIT_PAGE_SIZE).toBe(50);
  });
});
