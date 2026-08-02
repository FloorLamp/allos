import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 140 (issue #1854): an AMOUNT-aware daily maximum for the PRN safety
// counters, alongside the existing count form.
//
// ── THE GAP ──────────────────────────────────────────────────────────────────
//
// The `prn-max:` care finding and the redose ceiling compare today's
// ADMINISTRATION COUNT against the confirmed `max_daily_count` (#798). Since the
// counters became ingredient-family-wide (#1027), one "dose" can be 200 mg OTC
// ibuprofen or 800 mg Rx ibuprofen — so counting rows misreports real exposure in
// both directions: 3 × 800 mg (2400 mg, at the adult OTC ceiling) reads as a calm
// "3 of 6", while 6 × 200 mg (1200 mg) trips a 6-dose ceiling at half that.
//
// ── THE COLUMN ───────────────────────────────────────────────────────────────
//
// `max_daily_amount_mg` is the user-CONFIRMED daily milligram ceiling for the
// item's active ingredient (nullable REAL, mg canonical like every stored dose
// amount). Same confirm discipline as `max_daily_count`: never pre-applied, blank
// means the mg basis simply isn't available and the count form remains the
// fallback. The confirm-dose snapshot already stamps the amount onto every log
// row, so the day's exposure is summable from history with no backfill — NULL for
// every existing row, by construction.
//
// House rules (CLAUDE.md): a new column on an existing table gets a new
// migration, no rebuild. `intake_items` is already profile-owned and already in
// lib/owned-tables.ts. Self-contained (imports nothing from lib/); a replay is
// decided purely by the DB catalog.

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const cols = db.prepare(`PRAGMA table_info(intake_items)`).all() as {
      name: string;
    }[];
    if (cols.length === 0) return; // table absent (never after 001; belt)
    if (cols.some((c) => c.name === "max_daily_amount_mg")) return;
    db.exec(
      `ALTER TABLE intake_items ADD COLUMN max_daily_amount_mg REAL`
      // The confirmed mg/day ceiling for the item's ingredient. NULL = not
      // confirmed → the count-based max stays the only basis.
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 140,
  name: "140-prn-max-daily-mg",
  up,
};
