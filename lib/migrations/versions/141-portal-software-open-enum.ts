import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 141 (issue #1836): drop the CHECK enum on `portals.software`, making the
// column what the write boundary already treats it as — bare TEXT validated in
// lib/portals.ts (`isPortalSoftware`, derived from the one SOFTWARE_VALUES tuple).
//
// ── WHY THE CONSTRAINT MOVES OUT OF THE SCHEMA ───────────────────────────────
//
// Migration 131 added the tag CHECK-constrained to ('mychart','cerner','generic-ccd'),
// calling the rebuild-per-growth friction intended. #1836 supersedes that ruling: the
// tag is display metadata plus a tool-side sanity hint — never identity, never routing —
// and its vocabulary is expected to grow a value at a time as companion tools appear
// (eClinicalWorks is the first). A table rebuild per vendor name is friction with no
// safety payoff, because nothing downstream trusts the column: resolution, bindings and
// uploads never read it. So the enum lives at the write boundary like
// `integration_connections.status`, where growing it is a one-line change to the tuple
// the type, the guard and the form all derive from.
//
// The rebuild copies rows verbatim (every stored value is inside the old enum by
// construction), keeps explicit ids so every portal_id reference holds, and recreates
// the one index. The runner applies migrations with foreign_keys off, which is what
// lets the DROP happen without cascading children away; nothing here needs nulling
// first because no link changes.
//
// House rules (CLAUDE.md): self-contained — imports nothing from lib/ — so a replay is
// decided purely by the DB catalog. Determinism (spec): reads only the DB catalog. The
// replay guard reads the live table's own DDL: once the CHECK is gone the migration is
// a no-op, so a re-run against an already-converged DB changes nothing.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'portals'"
      )
      .get() as { sql: string } | undefined;
    if (!row) return; // table absent (never happens after 128; belt)
    // Replay guard: the runner guarantees 131 ran first, so the column exists — and if
    // its DDL no longer carries the CHECK, this rebuild already happened.
    if (!/software\s+TEXT\s+CHECK/i.test(row.sql)) return;

    db.exec(
      `CREATE TABLE portals_rebuild (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         slug       TEXT NOT NULL,
         name       TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         software   TEXT
       )`
    );
    db.exec(
      `INSERT INTO portals_rebuild (id, slug, name, created_at, software)
         SELECT id, slug, name, created_at, software FROM portals`
    );
    db.exec(`DROP TABLE portals`);
    db.exec(`ALTER TABLE portals_rebuild RENAME TO portals`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_portals_slug
         ON portals(slug COLLATE NOCASE)`
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 141,
  name: "141-portal-software-open-enum",
  up,
};
