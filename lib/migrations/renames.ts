import type Database from "better-sqlite3";
import { tableColumns } from "./schema-utils";

// Pre-CREATE table-rename shims, extracted verbatim from lib/db.ts. Each runs at
// the very start of migrate() — BEFORE the CREATE TABLE IF NOT EXISTS blocks — so
// an existing dev/prod DB carries its rows over under the new name instead of the
// CREATE block minting a fresh empty table. All three are idempotent (rename only
// when the old name exists and the new one doesn't) and behavior-preserving.

// Branch-era shim (PR #100): rename the old auth tables/column to their new
// names in place. See the call site in migrate() for the full rationale.
// Idempotent — renames only when the old name exists and the new one doesn't.
export function renameAuthTablesForBranch(db: Database.Database) {
  const hasTable = (t: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t);
  for (const [oldName, newName] of [
    ["accounts", "logins"],
    ["account_profiles", "login_profiles"],
    ["account_settings", "login_settings"],
  ]) {
    if (hasTable(oldName) && !hasTable(newName)) {
      db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
    }
  }
  // The renamed tables still carry the old `account_id` column — rename it too.
  for (const t of ["login_profiles", "login_settings", "sessions"]) {
    if (hasTable(t) && tableColumns(db, t).includes("account_id")) {
      db.exec(`ALTER TABLE ${t} RENAME COLUMN account_id TO login_id`);
    }
  }
  db.exec("DROP INDEX IF EXISTS idx_sessions_account");
}

// Rename the weigh_ins table to body_metrics in place (#120). Idempotent: only
// renames when the old table exists and the new one doesn't. A plain ALTER RENAME
// preserves rows, columns, and indexes (the indexes follow the table and are
// dropped/recreated later by the profile-scoping rebuild + index swap). The NOT
// NULL on weight_kg survives the rename and is dropped later by
// relaxBodyMetricsWeightKg. Runs before the CREATE TABLE IF NOT EXISTS blocks so
// they find body_metrics already present rather than creating an empty one.
export function migrateWeighInsToBodyMetrics(db: Database.Database) {
  const hasTable = (t: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t);
  if (hasTable("weigh_ins") && !hasTable("body_metrics")) {
    try {
      db.exec("ALTER TABLE weigh_ins RENAME TO body_metrics");
    } catch (err) {
      // `next build` runs migrate() in several workers at once; two can both pass
      // the check above and race to rename, and the loser hits "no such table:
      // weigh_ins" / "table body_metrics already exists" (not SQLITE_BUSY, so the
      // busy_timeout doesn't cover it). Swallow it once the rename has landed —
      // the table exists under its new name, which is all we need. Re-throw else.
      if (!hasTable("body_metrics")) throw err;
    }
  }
}

// Rename the supplements table family to intake_items in place (#147): the tables
// now hold both supplements and medications (split by `kind`), so the old names
// misrepresent the contents. Each table is renamed independently and only when
// the old name exists and the new one doesn't, so this is idempotent and handles
// a partially-migrated DB (e.g. one that predates the dose/pair split, where only
// supplements + supplement_logs exist — the later migrations then create the rest
// under their new names). A plain ALTER RENAME preserves rows/columns/indexes and
// (with foreign_keys ON, legacy_alter_table OFF) rewrites child FK references from
// supplements(id) to intake_items(id). The old-named indexes follow their table
// across the rename; drop them so the CREATE INDEX statements later rebuild them
// under the new names instead of leaving stale duplicates. Runs before the CREATE
// TABLE IF NOT EXISTS blocks so they find the renamed tables already present. The
// `supplement_id` FK columns are intentionally left as-is (data-layer name churn
// only). No behavior change.
export function migrateSupplementsToIntakeItems(db: Database.Database) {
  const hasTable = (t: string) =>
    !!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(t);
  const renames: [string, string][] = [
    ["supplements", "intake_items"],
    ["supplement_doses", "intake_item_doses"],
    ["supplement_logs", "intake_item_logs"],
    ["supplement_pairs", "intake_item_pairs"],
    ["supplement_suggestions", "intake_item_suggestions"],
  ];
  for (const [oldName, newName] of renames) {
    if (hasTable(oldName) && !hasTable(newName)) {
      try {
        db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
      } catch (err) {
        // Same parallel-worker race as migrateWeighInsToBodyMetrics: swallow the
        // error once the table exists under its new name; re-throw otherwise.
        if (!hasTable(newName)) throw err;
      }
    }
  }
  // Drop the old-named indexes that rode along with their renamed tables, so the
  // CREATE INDEX statements below (re)build them under the new names. No-op on a
  // fresh DB, where these never existed.
  db.exec(`
    DROP INDEX IF EXISTS idx_suplog_date;
    DROP INDEX IF EXISTS idx_supp_sugg_status;
    DROP INDEX IF EXISTS idx_supp_doses_supp;
  `);
}
