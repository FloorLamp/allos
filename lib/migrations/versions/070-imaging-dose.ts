import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 070 (issue #703): the effective-radiation-dose column on the imaging
// study record (migration 037, #702). One nullable REAL — the study's effective
// dose in millisieverts (mSv) — captured MANUALLY on the imaging form or, rarely,
// filled by AI extraction when a report actually prints a dose (most consumer-facing
// radiology reports do NOT, so this is opt-in / manual-first, never an auto-win).
//
// When a study carries no recorded dose, the Imaging section falls back to a curated
// typical-dose-by-modality ESTIMATE (lib/datasets/data/radiation-dose.json) — clearly
// labeled estimate-vs-recorded and never summed into the recorded figure. A calm,
// informational trailing-window cumulative total surfaces on the Imaging page; it is
// never alarmist and never a "you've had too much" verdict — dose is a provider
// conversation.
//
// A single ADD COLUMN on an existing profile-owned table: no new table, no change to
// the import footprint (imaging_studies is already cleared/moved/counted by
// document_id). ADD COLUMN is inherently idempotent-guarded here — the runner runs
// each migration exactly once by user_version — but the non-version-gated migrate()
// replay used by the DB-tier tests re-applies migrations against an already-current
// schema, so the column add is wrapped to no-op when it already exists (SQLite has no
// ADD COLUMN IF NOT EXISTS). Determinism (spec): reads only the DB + its own
// constants.

export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(imaging_studies)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === "dose_msv")) {
    db.exec(`ALTER TABLE imaging_studies ADD COLUMN dose_msv REAL`);
  }
}

export const migration: Migration = {
  id: 70,
  name: "070-imaging-dose",
  up,
};
