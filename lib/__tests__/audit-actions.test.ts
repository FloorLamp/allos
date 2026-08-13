import { describe, it, expect } from "vitest";
import {
  AUDIT_ACTIONS,
  actionDomain,
  matchesActionPrefix,
  retentionModifier,
  rowsToPrune,
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

  // #1843. The pair is deliberately in the `login` domain rather than a new
  // `session` one: the viewer's action filter groups on the domain, and
  // `login.logout` is already a session-ending event, so a `session.*` spelling
  // would split "a session ended" across two filter groups.
  it("session revocation lives in the login domain, beside logout", () => {
    expect(AUDIT_ACTIONS.sessionRevoke).toBe("login.session-revoke");
    expect(AUDIT_ACTIONS.sessionRevokeAll).toBe("login.session-revoke-all");
    expect(actionDomain(AUDIT_ACTIONS.sessionRevoke)).toBe(
      actionDomain(AUDIT_ACTIONS.logout)
    );
    expect(actionDomain(AUDIT_ACTIONS.sessionRevokeAll)).toBe("login");
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

describe("pagination", () => {
  // The arithmetic moved to lib/pagination.ts (lib/__tests__/pagination.test.ts);
  // what stays here is this viewer's own page-size policy.
  it("default page size", () => {
    expect(AUDIT_PAGE_SIZE).toBe(50);
  });
});
