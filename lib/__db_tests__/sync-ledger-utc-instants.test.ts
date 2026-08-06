// DB INTEGRATION TIER — migration 163 (#2205 phase 1): the integration sync ledger
// moves onto the canonical stored instant, 'YYYY-MM-DDTHH:MM:SSZ'.
//
// Two halves, because the issue makes two distinct claims:
//
//   1. the conversion PRESERVES VALUE — same instants, same ordering, same
//      comparisons, and the column's DEFAULT stops re-introducing the old shape;
//   2. the CROSS-DOMAIN JOIN — the query shape the issue says produced two
//      confidently wrong analyses — returns correct results against converted data.
//
// The second half is the one worth reading. Both of these queries join the sync
// ledger to `metric_samples`, whose instants have always carried a `Z`, and both are
// wrong when the two sides disagree about serialization — not by throwing, but by
// answering.

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { up } from "@/lib/migrations/versions/163-sync-ledger-utc-instants";
import { db } from "@/lib/db";
import { utcInstant } from "@/lib/date";
import { getSleepArrivalLagMinutes } from "@/lib/queries/sleep";

// The pre-163 schema, reduced to what the migration touches: bare column DEFAULTs and
// the two indexes on `at`.
function legacyDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO profiles (id, name) VALUES (1, 'Ledger');
    CREATE TABLE portals (id INTEGER PRIMARY KEY);
    CREATE TABLE portal_accounts (id INTEGER PRIMARY KEY);
    CREATE TABLE integration_sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      provider TEXT NOT NULL,
      at TEXT NOT NULL,
      ok INTEGER NOT NULL,
      window_start TEXT,
      window_end TEXT,
      received INTEGER,
      written INTEGER,
      skipped INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      inserted INTEGER,
      updated INTEGER,
      unchanged INTEGER,
      raw_ref TEXT,
      suppressed INTEGER,
      edited INTEGER,
      details TEXT,
      portal_id INTEGER REFERENCES portals(id) ON DELETE SET NULL,
      account_id INTEGER REFERENCES portal_accounts(id) ON DELETE SET NULL,
      patient_label TEXT
    );
    CREATE INDEX idx_sync_events_profile_provider_at
      ON integration_sync_events(profile_id, provider, at);
    CREATE INDEX idx_sync_events_identity
      ON integration_sync_events(portal_id, account_id, patient_label, at);
    CREATE TABLE integration_sync_rows (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL REFERENCES integration_sync_events(id) ON DELETE CASCADE,
      target_table TEXT NOT NULL CHECK (target_table IN ('activities','body_metrics','metric_samples','medical_records','practice_logs')),
      target_id    INTEGER NOT NULL,
      disposition  TEXT NOT NULL CHECK (disposition IN ('inserted','updated')),
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_integration_sync_rows_event ON integration_sync_rows(event_id);
  `);
  // Mirror the runner (lib/migrations/runner.ts): migrations are applied with
  // foreign_keys DISABLED and the prior setting restored after, because SQLite's own
  // documented table-rebuild procedure requires it — this migration rebuilds a FK
  // PARENT, and with enforcement on the DROP would cascade the child rows away.
  // better-sqlite3 turns foreign_keys ON by default, so a fixture that skipped this
  // would be testing a configuration the runner never uses.
  mem.pragma("foreign_keys = OFF");
  return mem;
}

function seedEvent(mem: Database.Database, at: string, createdAt = at): number {
  return Number(
    mem
      .prepare(
        `INSERT INTO integration_sync_events (profile_id, provider, at, ok, created_at)
         VALUES (1, 'health-connect', ?, 1, ?)`
      )
      .run(at, createdAt).lastInsertRowid
  );
}

function ats(mem: Database.Database): string[] {
  return (
    mem.prepare("SELECT at FROM integration_sync_events ORDER BY id").all() as {
      at: string;
    }[]
  ).map((r) => r.at);
}

describe("migration 163 — the sync ledger's instants state their zone", () => {
  it("appends Z to values that already ARE UTC, changing no instant", () => {
    const mem = legacyDb();
    seedEvent(mem, "2026-07-15 20:02:03");
    seedEvent(mem, "2026-03-08 07:30:00");
    up(mem);

    expect(ats(mem)).toEqual(["2026-07-15T20:02:03Z", "2026-03-08T07:30:00Z"]);
    // The claim that makes this value-preserving: SQLite reads the new string as the
    // same absolute instant it read the old one as.
    const same = mem
      .prepare(
        `SELECT julianday(at) - julianday('2026-07-15 20:02:03') AS d
           FROM integration_sync_events WHERE id = 1`
      )
      .get() as { d: number };
    expect(same.d).toBe(0);
  });

  it("preserves ordering and range comparisons across the rewrite", () => {
    const mem = legacyDb();
    // Deliberately inserted out of order, and spanning a day boundary — the place a
    // separator change could plausibly have reordered rows.
    for (const at of [
      "2026-07-15 23:59:59",
      "2026-07-15 00:00:00",
      "2026-07-16 00:00:01",
      "2026-07-15 12:00:00",
    ])
      seedEvent(mem, at);
    const before = (
      mem
        .prepare("SELECT id FROM integration_sync_events ORDER BY at, id")
        .all() as { id: number }[]
    ).map((r) => r.id);

    up(mem);

    const after = (
      mem
        .prepare("SELECT id FROM integration_sync_events ORDER BY at, id")
        .all() as { id: number }[]
    ).map((r) => r.id);
    expect(after).toEqual(before);

    // And the range predicate every reader uses still selects the same set — now
    // against a cutoff in the column's own convention.
    const inWindow = (
      mem
        .prepare(
          "SELECT id FROM integration_sync_events WHERE at >= ? ORDER BY id"
        )
        .all(utcInstant(new Date("2026-07-15T12:00:00Z"))) as { id: number }[]
    ).map((r) => r.id);
    expect(inWindow).toEqual([1, 3, 4]);
  });

  it("converts the child provenance stamps with their parent", () => {
    const mem = legacyDb();
    const eventId = seedEvent(mem, "2026-07-15 20:02:03");
    mem
      .prepare(
        `INSERT INTO integration_sync_rows
           (event_id, target_table, target_id, disposition, created_at)
         VALUES (?, 'metric_samples', 7, 'inserted', '2026-07-15 20:02:05')`
      )
      .run(eventId);
    up(mem);
    expect(
      mem.prepare("SELECT created_at FROM integration_sync_rows").get()
    ).toEqual({ created_at: "2026-07-15T20:02:05Z" });
  });

  it("stops the DEFAULT re-introducing the bare shape on the next insert", () => {
    // The reason this is a rebuild and not an UPDATE: SQLite cannot ALTER a DEFAULT,
    // so an in-place conversion would have been undone by the very next sync.
    const mem = legacyDb();
    up(mem);
    const id = Number(
      mem
        .prepare(
          `INSERT INTO integration_sync_events (profile_id, provider, at, ok)
           VALUES (1, 'strava', '2026-07-15T20:02:03Z', 1)`
        )
        .run().lastInsertRowid
    );
    const row = mem
      .prepare("SELECT created_at FROM integration_sync_events WHERE id = ?")
      .get(id) as { created_at: string };
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it("leaves an already-converted value alone and replays as a no-op", () => {
    const mem = legacyDb();
    seedEvent(mem, "2026-07-15 20:02:03");
    // A value some other path already wrote in ISO form — it must not gain a second Z.
    seedEvent(mem, "2026-07-16T08:00:00Z");
    up(mem);
    const once = ats(mem);
    up(mem);
    expect(ats(mem)).toEqual(once);
    expect(once).toEqual(["2026-07-15T20:02:03Z", "2026-07-16T08:00:00Z"]);
  });

  it("keeps the indexes and the cascade the rebuild had to recreate", () => {
    const mem = legacyDb();
    const eventId = seedEvent(mem, "2026-07-15 20:02:03");
    mem
      .prepare(
        `INSERT INTO integration_sync_rows (event_id, target_table, target_id, disposition)
         VALUES (?, 'metric_samples', 7, 'inserted')`
      )
      .run(eventId);
    up(mem);

    const indexes = (
      mem
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
            AND tbl_name IN ('integration_sync_events','integration_sync_rows')
              AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toEqual([
      "idx_integration_sync_rows_event",
      "idx_sync_events_identity",
      "idx_sync_events_profile_provider_at",
    ]);

    mem.pragma("foreign_keys = ON");
    mem
      .prepare("DELETE FROM integration_sync_events WHERE id = ?")
      .run(eventId);
    expect(
      mem.prepare("SELECT COUNT(*) AS n FROM integration_sync_rows").get()
    ).toEqual({ n: 0 });
  });
});

// ---------------------------------------------------------------------------

describe("the cross-domain join the wrong analyses came from (#2205)", () => {
  // The sleep ARRIVAL LAG: how long after a night ends its row actually lands. It
  // joins `integration_sync_rows.created_at` (the sync ledger) to
  // `metric_samples.end_time` (the observation store) and subtracts them. One side was
  // bare, the other has always carried a `Z` — the exact shape of read the issue says
  // produced a confident wrong answer.
  function seedArrival(
    profileId: number,
    wakeDay: string,
    lagMin: number
  ): void {
    const start = `${wakeDay}T22:30:00Z`;
    const end = `${wakeDay}T06:30:00Z`;
    const sampleId = Number(
      db
        .prepare(
          `INSERT INTO metric_samples
             (profile_id, source, metric, date, start_time, end_time, value)
           VALUES (?, 'health-connect', 'sleep_min', ?, ?, ?, 480)`
        )
        .run(profileId, wakeDay, start, end).lastInsertRowid
    );
    const arrived = utcInstant(new Date(Date.parse(end) + lagMin * 60_000));
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO integration_sync_events (profile_id, provider, at, ok)
           VALUES (?, 'health-connect', ?, 1)`
        )
        .run(profileId, arrived).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO integration_sync_rows
         (event_id, target_table, target_id, disposition, created_at)
       VALUES (?, 'metric_samples', ?, 'inserted', ?)`
    ).run(eventId, sampleId, arrived);
  }

  it("measures the arrival lag correctly with both sides on the canonical instant", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ArrivalJoin')").run()
        .lastInsertRowid
    );
    // Seven mornings, a known 45-minute lag each. The median is the assertion.
    for (let back = 1; back <= 7; back++) {
      const day = new Date(Date.UTC(2026, 4, 10 + back))
        .toISOString()
        .slice(0, 10);
      seedArrival(profileId, day, 45);
    }
    expect(getSleepArrivalLagMinutes(profileId)).toBe(45);
  });

  it("windows arrivals by an instant cursor rather than a bare string", () => {
    // The `arrivalChanges` shape: SUM(CASE WHEN e.at > ? ...) split at a cursor. With
    // the ledger converted, the cursor is a canonical instant — and this is where the
    // OLD bare cursor answered wrong. A bare 'YYYY-MM-DD HH:MM:SS' cursor compared
    // against a `Z` column is a LEXICAL comparison in which ' ' (0x20) sorts before
    // 'T' (0x54), so for any event on the cursor's own day the predicate is true
    // whatever the times actually are — every same-day row counts as "new".
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('ArrivalWindow')").run()
        .lastInsertRowid
    );
    const insert = db.prepare(
      `INSERT INTO integration_sync_events (profile_id, provider, at, ok)
       VALUES (?, 'health-connect', ?, 1)`
    );
    insert.run(profileId, "2026-05-20T02:00:00Z"); // before the cursor
    insert.run(profileId, "2026-05-20T09:00:00Z"); // before the cursor
    insert.run(profileId, "2026-05-20T23:00:00Z"); // after
    const cursor = utcInstant(new Date("2026-05-20T12:00:00Z"));

    const split = db
      .prepare(
        `SELECT SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS n_new,
                SUM(CASE WHEN at <= ? THEN 1 ELSE 0 END) AS n_prior
           FROM integration_sync_events WHERE profile_id = ?`
      )
      .get(cursor, cursor, profileId) as { n_new: number; n_prior: number };
    expect(split).toEqual({ n_new: 1, n_prior: 2 });

    // The same data through the pre-163 cursor shape, pinned so the failure mode is
    // visible rather than remembered: everything looks new.
    const bareCursor = "2026-05-20 12:00:00";
    const wrong = db
      .prepare(
        `SELECT SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS n_new
           FROM integration_sync_events WHERE profile_id = ?`
      )
      .get(bareCursor, profileId) as { n_new: number };
    expect(wrong.n_new).toBe(3);
  });
});
