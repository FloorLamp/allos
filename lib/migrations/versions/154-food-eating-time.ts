import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 154 (issue #2019): the food ledger's OWN eating-time capture.
//
// Migration 056 wrote the rule this migration obeys rather than bends: `logged_at` is
// TAP time, "NEVER backfilled … A future eating-time consumer needs its own capture,
// not a reinterpretation of this column". This is that capture.
//
//   • `eaten_at` — when the serving was actually EATEN, as a UTC instant. NULL means
//     "nobody has said", which is a real and common answer: historical rows have it,
//     and a web backfill with no stated time keeps it, because defaulting to now would
//     reintroduce exactly the guess this column exists to end — under a more
//     authoritative name.
//   • `time_source` — 'tap' when the instant is the tap's own contract ("I'm eating
//     now", the Telegram button's declared meaning, a measurement with known error),
//     'stated' once a human has corrected it. This is what lets any future insight
//     state its basis — "from the N% of logs carrying a time" — and admit a tap-sourced
//     instant for a coarse window while requiring a stated one for anything finer.
//
// `logged_at` is untouched and stays the immutable audit stamp AND the ranking input:
// ranking predicts the next TAP. No backfill — a historical row genuinely has no
// eating time, and inventing one from its tap stamp would be the same reinterpretation
// 056 forbade.
//
// Additive and nullable, so every existing reader is byte-identical and no rebuild is
// needed; the CHECK protects the two-value vocabulary without one. A future vocabulary
// change appends a rebuild migration. The column guards keep a replay a no-op.
// Determinism: reads only the DB and its own constants.

export function up(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(food_log_events)").all() as {
    name: string;
  }[];
  const has = (name: string) => cols.some((c) => c.name === name);
  if (!has("eaten_at")) {
    db.exec(`ALTER TABLE food_log_events ADD COLUMN eaten_at TEXT`);
  }
  if (!has("time_source")) {
    db.exec(
      `ALTER TABLE food_log_events
       ADD COLUMN time_source TEXT
       CHECK (time_source IS NULL OR time_source IN ('tap', 'stated'))`
    );
  }
}

export const migration: Migration = {
  id: 154,
  name: "154-food-eating-time",
  up,
};
