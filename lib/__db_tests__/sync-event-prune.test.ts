// DB INTEGRATION TIER — the integration_sync_events retention sweep (issue #388).
//
// Proves two things about pruneSyncEvents against a real schema:
//   1. Equivalence: the rows the DB DELETE removes are EXACTLY the ids the pure
//      planSyncEventPrune predicts for the same cutoff — so the sweep's policy is the
//      unit-tested pure decision, not a second hand-rolled rule that can drift.
//   2. The newest event per (profile, source) survives regardless of age, so a
//      dormant source's last-known state stays visible to
//      getLatestSyncEventPerSource / the failure detector after the sweep.
//
// Events are seeded well away from the 90-day boundary so a few-ms drift between the
// test's computed cutoff and the DELETE's own datetime('now') can't flip a row.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { utcInstant } from "@/lib/date";
import { db } from "@/lib/db";
import { pruneSyncEvents } from "@/lib/integrations/connections";
import { getLatestSyncEventPerSource } from "@/lib/queries";
import { planSyncEventPrune } from "@/lib/integrations/sync-log";
import { SYNC_EVENTS_RETENTION_DAYS } from "@/lib/retention";

let pA: number;
let pB: number;

// Insert an event with an explicit age (days before now) so classification is
// deterministic. `at` uses the same datetime('now', modifier) arithmetic the DELETE
// uses, so the two agree on the wall clock.
function insertAged(
  profileId: number,
  sourceId: string,
  daysAgo: number,
  ok = true
): void {
  db.prepare(
    // Bound in the column's own convention (#2205, migration 163). Seeding SQLite's
    // bare `datetime('now', ?)` here would have put a second serialization in the
    // column the sweep compares, which is the failure this whole issue is about.
    `INSERT INTO integration_sync_events (profile_id, provider, at, ok)
       VALUES (?, ?, ?, ?)`
  ).run(
    profileId,
    sourceId,
    utcInstant(new Date(Date.now() - daysAgo * 86_400_000)),
    ok ? 1 : 0
  );
}

type Ev = { id: number; profile_id: number; sourceId: string; at: string };

function allEvents(): Ev[] {
  return db
    .prepare(
      "SELECT id, profile_id, provider, at FROM integration_sync_events ORDER BY id"
    )
    .all() as Ev[];
}

beforeAll(() => {
  pA = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('PRUNE-A')").run()
      .lastInsertRowid
  );
  pB = Number(
    db.prepare("INSERT INTO profiles (name) VALUES ('PRUNE-B')").run()
      .lastInsertRowid
  );

  // Profile A / health-connect: a flood — mostly old, one recent. The old ones EXCEPT
  // the newest-per-source (which is the recent one here) should prune.
  insertAged(pA, "health-connect", 200);
  insertAged(pA, "health-connect", 150);
  insertAged(pA, "health-connect", 100); // still > 90 → old
  insertAged(pA, "health-connect", 3); // recent + newest → kept

  // Profile A / strava: a dormant broken source — ALL events are old, last is a
  // failure 120 days ago. Its newest must survive so the failure stays detectable.
  insertAged(pA, "strava", 400);
  insertAged(pA, "strava", 120, false); // newest strava/A, old, failure → kept

  // Profile B / oura: only recent events → nothing prunes.
  insertAged(pB, "oura", 10);
  insertAged(pB, "oura", 2);
});

describe("pruneSyncEvents equals planSyncEventPrune (#388)", () => {
  it("deletes exactly the ids the pure decision predicts", () => {
    const before = allEvents();
    const cutoff = (
      db
        .prepare("SELECT datetime('now', ?) AS t")
        .get(`-${SYNC_EVENTS_RETENTION_DAYS} days`) as { t: string }
    ).t;
    const predicted = new Set(planSyncEventPrune(before, cutoff));
    // Sanity: the fixture actually exercises a non-trivial prune.
    expect(predicted.size).toBeGreaterThan(0);

    const deleted = pruneSyncEvents();
    expect(deleted).toBe(predicted.size);

    const remainingIds = new Set(allEvents().map((e) => e.id));
    // Every predicted id is gone; every non-predicted id survives.
    for (const e of before) {
      expect(remainingIds.has(e.id)).toBe(!predicted.has(e.id));
    }
  });

  it("keeps the newest event per (profile, provider) — dormant broken provider stays visible", () => {
    // After the sweep, strava/A's failure (120 days old, its newest) is still there.
    const latestA = getLatestSyncEventPerSource(pA);
    const strava = latestA.find((e) => e.source_id === "strava");
    expect(strava).toBeDefined();
    expect(strava!.ok).toBe(0);
    // One row per source that had history, both sources still represented.
    expect(new Set(latestA.map((e) => e.source_id))).toEqual(
      new Set(["health-connect", "strava"])
    );
  });

  it("is idempotent — a second sweep removes nothing", () => {
    expect(pruneSyncEvents()).toBe(0);
  });

  it("never drops a provider's only event, even when ancient", () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('PRUNE-SOLO')").run()
        .lastInsertRowid
    );
    insertAged(p, "strava", 900); // ancient, but the only strava event for p
    expect(pruneSyncEvents()).toBe(0);
    expect(getLatestSyncEventPerSource(p).map((e) => e.source_id)).toEqual([
      "strava",
    ]);
  });
});
