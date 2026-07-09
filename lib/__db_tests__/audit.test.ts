// DB INTEGRATION TIER — the audit log (issue #22) against a real in-memory
// SQLite handle:
//   1. recordAudit inserts a row with the passed identifiers, defaulting ts + the
//      nullable login/profile columns.
//   2. recordAudit never throws, even on a bad row — the request it audits must
//      not break because of its own logging.
//   3. queryAuditEvents filters (login / action prefix / profile) and paginates
//      with server-side LIMIT/OFFSET, newest-first.
//   4. pruneAuditEvents removes rows past the age cutoff (maxDays) and enforces a
//      hard maxRows cap.
// The pure helpers (action naming, retention/pagination math) are covered in
// lib/__tests__/audit-actions.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { recordAudit, pruneAuditEvents } from "@/lib/audit";
import { queryAuditEvents, auditFilterOptions } from "@/lib/audit-query";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

function clearAudit() {
  db.prepare("DELETE FROM audit_events").run();
}

// Insert a row with an explicit ts, bypassing the writer's default — used to
// simulate old rows for the retention sweep.
function insertAt(ts: string, action: string) {
  db.prepare("INSERT INTO audit_events (ts, action) VALUES (?, ?)").run(
    ts,
    action
  );
}

beforeEach(() => {
  clearAudit();
});

describe("recordAudit", () => {
  it("inserts a row with the given fields and a default ts", () => {
    recordAudit({
      loginId: 1,
      profileId: 2,
      action: AUDIT_ACTIONS.medicalFileView,
      target: "77",
      detail: "note",
    });
    const row = db
      .prepare(
        "SELECT login_id, active_profile_id, action, target, detail, ts FROM audit_events"
      )
      .get() as Record<string, unknown>;
    expect(row.login_id).toBe(1);
    expect(row.active_profile_id).toBe(2);
    expect(row.action).toBe("medical-file.view");
    expect(row.target).toBe("77");
    expect(row.detail).toBe("note");
    expect(typeof row.ts).toBe("string");
    expect(row.ts).not.toBe("");
  });

  it("defaults login/profile/target/detail to NULL when omitted", () => {
    recordAudit({ action: AUDIT_ACTIONS.loginFailure, detail: "someuser" });
    const row = db
      .prepare(
        "SELECT login_id, active_profile_id, target, detail FROM audit_events"
      )
      .get() as Record<string, unknown>;
    expect(row.login_id).toBeNull();
    expect(row.active_profile_id).toBeNull();
    expect(row.target).toBeNull();
    expect(row.detail).toBe("someuser");
  });

  it("caps over-long identifier fields instead of storing unbounded text", () => {
    const long = "x".repeat(5000);
    recordAudit({ action: "test.cap", target: long, detail: long });
    const row = db.prepare("SELECT target, detail FROM audit_events").get() as {
      target: string;
      detail: string;
    };
    expect(row.target.length).toBeLessThanOrEqual(200);
    expect(row.detail.length).toBeLessThanOrEqual(200);
  });

  it("never throws on a bad insert (returns quietly)", () => {
    // action is NOT NULL in the schema; passing null must be swallowed, not thrown.
    expect(() =>
      recordAudit({ action: null as unknown as string })
    ).not.toThrow();
    // Nothing was inserted.
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
  });
});

describe("queryAuditEvents", () => {
  beforeEach(() => {
    recordAudit({ loginId: 1, action: AUDIT_ACTIONS.loginSuccess });
    recordAudit({ loginId: 1, action: AUDIT_ACTIONS.loginFailure });
    recordAudit({
      loginId: 2,
      profileId: 5,
      action: AUDIT_ACTIONS.medicalFileView,
      target: "9",
    });
    recordAudit({
      loginId: 2,
      profileId: 5,
      action: AUDIT_ACTIONS.profileSwitch,
    });
  });

  it("returns newest-first with a total", () => {
    const { rows, total } = queryAuditEvents();
    expect(total).toBe(4);
    expect(rows).toHaveLength(4);
    // Newest (last inserted) first.
    expect(rows[0].action).toBe("profile.switch");
  });

  it("filters by login id", () => {
    const { rows, total } = queryAuditEvents({ loginId: 1 });
    expect(total).toBe(2);
    expect(rows.every((r) => r.login_id === 1)).toBe(true);
  });

  it("filters by action domain prefix (matches every action in the domain)", () => {
    const { rows, total } = queryAuditEvents({ actionPrefix: "login" });
    expect(total).toBe(2);
    expect(rows.every((r) => r.action.startsWith("login."))).toBe(true);
  });

  it("filters by active profile id", () => {
    const { rows, total } = queryAuditEvents({ profileId: 5 });
    expect(total).toBe(2);
    expect(rows.every((r) => r.active_profile_id === 5)).toBe(true);
  });

  it("paginates with server-side LIMIT/OFFSET", () => {
    const p1 = queryAuditEvents({}, 1, 2);
    const p2 = queryAuditEvents({}, 2, 2);
    expect(p1.total).toBe(4);
    expect(p1.rows).toHaveLength(2);
    expect(p2.rows).toHaveLength(2);
    // No overlap between pages.
    const ids = new Set([...p1.rows, ...p2.rows].map((r) => r.id));
    expect(ids.size).toBe(4);
  });

  it("surfaces distinct action domains for the filter dropdown", () => {
    const { actionDomains } = auditFilterOptions();
    expect(actionDomains).toContain("login");
    expect(actionDomains).toContain("medical-file");
    expect(actionDomains).toContain("profile");
    // Sorted + de-duped (login.success + login.failure collapse to one "login").
    expect(actionDomains).toEqual([...actionDomains].sort());
  });
});

describe("pruneAuditEvents", () => {
  it("deletes rows older than maxDays and keeps recent ones", () => {
    insertAt("2000-01-01 00:00:00", "old.event");
    recordAudit({ action: "new.event" });
    const deleted = pruneAuditEvents({ maxDays: 90 });
    expect(deleted).toBe(1);
    const remaining = db.prepare("SELECT action FROM audit_events").all() as {
      action: string;
    }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].action).toBe("new.event");
  });

  it("enforces a hard maxRows cap, keeping the newest", () => {
    for (let i = 0; i < 5; i++) recordAudit({ action: `e.${i}` });
    // Keep only the 2 newest by id; maxDays huge so age never trims here.
    const deleted = pruneAuditEvents({ maxDays: 100000, maxRows: 2 });
    expect(deleted).toBe(3);
    const remaining = db
      .prepare("SELECT action FROM audit_events ORDER BY id")
      .all() as { action: string }[];
    expect(remaining.map((r) => r.action)).toEqual(["e.3", "e.4"]);
  });

  it("defaults to a 90-day retention when called with no args", () => {
    insertAt("2000-01-01 00:00:00", "ancient");
    recordAudit({ action: "fresh" });
    expect(pruneAuditEvents()).toBe(1);
    expect(
      (
        db.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
  });
});
