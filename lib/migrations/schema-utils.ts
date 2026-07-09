import type Database from "better-sqlite3";

// Low-level schema-introspection helper shared by lib/db.ts's migrate()
// orchestration and the extracted migration modules under lib/migrations/. Lives
// here (rather than in lib/db.ts) so the migration modules can use it without an
// import cycle back into lib/db.ts.

// The column names of a table. The table name is interpolated (not bound) so the
// profile-scoping source scanner sees a variable, not an owned-table literal, in
// this PRAGMA — which legitimately touches any table without a profile_id filter.
export function tableColumns(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}
