import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 141 (issue #1866): the follow-up TERMINATOR — persistent resolve/decline
// state for a tracked finding follow-up.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// #1866 lets an OVERDUE safety follow-up finally push (the tracked due date is the
// consent — the same structure as a dose reminder), and the owner ruling makes the
// per-item terminator the ONLY off-switch: no notification setting anywhere. An
// escalating push without a first-class "this is handled" write is a nag machine, so
// the terminator must be durable state on the chain node itself:
//
//   - "done on <date>"            — the follow-up happened outside the app's records
//                                   (the CT was done at an outside clinic); or
//   - "discussed, not doing it"   — a deliberate, informed decline, with an optional
//                                   free-text reason.
//
// Either one closes the chain node permanently: the finding stops rendering, the
// push stops forever, and the row keeps an honest record of WHY it closed. This is
// deliberately DISTINCT from `resolution` (migration 050): a resolution records what
// a LATER RECORD showed (resolved/stable/changed — the serial-tracking verdict); a
// settle records the user's own statement about the follow-up itself, with no record
// to pin. Overloading `resolution` would have made "the scan showed the nodule is
// stable" and "we decided not to scan" indistinguishable.
//
// ── COLUMNS (all nullable — a generic care-plan item and every pre-existing row
//    set none of them) ─────────────────────────────────────────────────────────
//
//   settled_disposition TEXT — 'done' | 'declined'. Validated in code
//                              (normalizeSettleDisposition, lib/followup.ts), the
//                              same closed-in-code vocabulary style as `resolution`
//                              — no DB CHECK, so growing it later needs no rebuild.
//   settled_on          TEXT — the user-stated date (YYYY-MM-DD): the day the
//                              follow-up was done, or the day it was declined.
//   settled_reason      TEXT — optional free text ("discussed with Dr. F, low
//                              yield"); rendered through <NotesText>.
//
// The write core (settleFollowUpCore) also stamps `status` with the matching FHIR
// vocabulary the care-plan module already understands ('completed' / 'not-done'),
// so every existing open/closed read agrees without learning the new columns.
//
// House rules (CLAUDE.md): new columns on an existing table = a new migration, no
// rebuild. care_plan_items is already profile-owned and in lib/owned-tables.ts.
// Self-contained (imports nothing from lib/); reads only the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(care_plan_items)`).all() as {
      name: string;
    }[];
    const has = (name: string) => cols.some((c) => c.name === name);
    if (!has("settled_disposition")) {
      db.exec(
        `ALTER TABLE care_plan_items ADD COLUMN settled_disposition TEXT`
      );
    }
    if (!has("settled_on")) {
      db.exec(`ALTER TABLE care_plan_items ADD COLUMN settled_on TEXT`);
    }
    if (!has("settled_reason")) {
      db.exec(`ALTER TABLE care_plan_items ADD COLUMN settled_reason TEXT`);
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 141,
  name: "141-followup-settle",
  up,
};
