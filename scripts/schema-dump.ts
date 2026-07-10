// Print the current database schema (issue #119).
//
// Since the schema is no longer readable from one place in source — the CREATE
// blocks live in the frozen baseline migration and future changes are appended as
// separate migrations — this replaces "read the CREATE blocks in lib/db.ts" for
// humans. It opens a scratch in-memory database, runs EVERY migration through the
// runner, and prints `sqlite_master` (tables + indexes) as SQL, ordered. Tests can
// assert against the same dump.
//
//   npm run schema:dump              # print the whole schema
//
// No data/allos.db is touched; nothing is written to disk.

import Database from "better-sqlite3";
import { runMigrations } from "../lib/migrations/runner";

function main() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 10000");
  runMigrations(db);

  const rows = db
    .prepare(
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END,
                 tbl_name, name`
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];

  const version = db.pragma("user_version", { simple: true });
  // eslint-disable-next-line no-console
  console.log(`-- allos schema @ user_version = ${version}`);
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(`\n-- [${r.type}] ${r.name}\n${r.sql.trim()};`);
  }
  db.close();
}

main();
