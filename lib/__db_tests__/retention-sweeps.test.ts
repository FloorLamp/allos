// DB INTEGRATION TIER — the notify-tick retention sweeps (issue #98) against a real
// in-memory SQLite handle:
//   1. sweepReplayedKeys deletes replayed_keys rows older than the ~7-day window and
//      keeps recent ones (pruning on created_at).
//   2. pruneAuditEvents({ maxMonths }) deletes audit_events past the configured
//      month window and keeps recent ones (pruning on ts).
// Both delete GLOBALLY by age across every profile (these are maintenance sweeps,
// not profile-scoped reads). The pure window math is covered in
// lib/__tests__/retention.test.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { sweepReplayedKeys } from "@/lib/offline/writes";
import { pruneAuditEvents } from "@/lib/audit";
import { REPLAYED_KEYS_RETENTION_DAYS } from "@/lib/retention";

// A SQLite-computed timestamp `modifier` before now, e.g. daysAgo("-8 days"), so the
// aged rows the sweep sees are relative to the same `now` the DELETE uses.
function ago(modifier: string): string {
  return (
    db.prepare("SELECT datetime('now', ?) AS t").get(modifier) as { t: string }
  ).t;
}

function count(table: "replayed_keys" | "audit_events"): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

// profile_id 1 exists in the seeded fixture.
function insertReplayKey(key: string, createdAt: string) {
  db.prepare(
    "INSERT INTO replayed_keys (client_key, profile_id, flow, created_at) VALUES (?, 1, 'body-metric', ?)"
  ).run(key, createdAt);
}

function insertAudit(ts: string, action = "login.success") {
  db.prepare("INSERT INTO audit_events (ts, action) VALUES (?, ?)").run(
    ts,
    action
  );
}

describe("sweepReplayedKeys", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM replayed_keys").run();
  });

  it("deletes rows older than the window and keeps recent ones", () => {
    insertReplayKey("old", ago(`-${REPLAYED_KEYS_RETENTION_DAYS + 1} days`));
    insertReplayKey("fresh", ago("-1 days"));

    const deleted = sweepReplayedKeys();
    expect(deleted).toBe(1);

    const remaining = db
      .prepare("SELECT client_key FROM replayed_keys ORDER BY client_key")
      .all() as { client_key: string }[];
    expect(remaining.map((r) => r.client_key)).toEqual(["fresh"]);
  });

  it("keeps a row still inside the window (strictly-older only)", () => {
    insertReplayKey(
      "edge",
      ago(`-${REPLAYED_KEYS_RETENTION_DAYS} days`) // exactly at edge, so kept
    );
    // Nudge it just inside so the boundary can't flip on sub-second drift.
    db.prepare(
      "UPDATE replayed_keys SET created_at = datetime(created_at, '+1 hour') WHERE client_key = 'edge'"
    ).run();
    expect(sweepReplayedKeys()).toBe(0);
    expect(count("replayed_keys")).toBe(1);
  });

  it("returns 0 on an empty ledger", () => {
    expect(sweepReplayedKeys()).toBe(0);
  });
});

describe("pruneAuditEvents with a configured month window", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM audit_events").run();
  });

  it("deletes events older than maxMonths and keeps recent ones", () => {
    insertAudit("2000-01-01 00:00:00"); // ancient
    insertAudit(ago("-13 months")); // outside a 12-month window
    insertAudit(ago("-1 months")); // inside

    const deleted = pruneAuditEvents({ maxMonths: 12 });
    expect(deleted).toBe(2);
    expect(count("audit_events")).toBe(1);
  });

  it("keeps everything under a generous window", () => {
    insertAudit(ago("-23 months"));
    expect(pruneAuditEvents({ maxMonths: 24 })).toBe(0);
    expect(count("audit_events")).toBe(1);
  });
});
