import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 158 (issue #2121): the six notification slot-time settings move from
// integer HOURS to minute-of-day "HH:MM" values.
//
// The slot vocabulary went sub-hourly: `slotDue` compares minutes of day, the
// Settings UI writes "HH:MM", and `parseNotifyTime` (lib/notifications/schedule.ts)
// reads the new format. This migration converts the values already stored so no
// user's reminder time moves through the format change — a stored `7` has always
// meant 07:00, and becomes exactly "07:00".
//
// The six keys (their names keep the historical `_hour` suffix — renaming keys
// would buy nothing but a second migration surface):
//   notify_supp_morning_hour, notify_supp_midday_hour, notify_supp_evening_hour,
//   notify_supp_bedtime_hour, notify_digest_hour, notify_recap_hour
//
// SENTINELS SURVIVE UNTOUCHED. The value multiplexes four states (#1117):
// absent (no row — nothing to convert), "" (explicitly off), "auto" (follow wake
// time), and a number. Only the number converts; "auto" and "" pass through the
// integer guard below unmatched, so wake-following and off slots keep their exact
// stored bytes.
//
// The waking-window bounds (notify_waking_start/_end) and the global backup hour
// are DELIBERATELY not converted: they stay hour-typed settings with their current
// keys and meaning (#2121 constraint — no silent reinterpretation), and only the
// clock they compare against moved to minute grain.
//
// Replay-safe by format: the conversion targets only values that are a bare
// integer 0–23 (one or two ASCII digits, range-checked). A converted "07:00"
// contains ":" and never matches again, so a re-run is a byte-for-byte no-op.
// A corrupt value ("99", "eight") matches nothing and is left as it was — the
// reader has always treated it as its fallback, and inventing a time for it here
// would be a guess. Determinism: reads only the DB and its own constants.

const HOUR_KEYS = [
  "notify_supp_morning_hour",
  "notify_supp_midday_hour",
  "notify_supp_evening_hour",
  "notify_supp_bedtime_hour",
  "notify_digest_hour",
  "notify_recap_hour",
] as const;

export function up(db: Database.Database): void {
  const placeholders = HOUR_KEYS.map(() => "?").join(", ");
  db.prepare(
    `UPDATE profile_settings
        SET value = printf('%02d:00', CAST(value AS INTEGER))
      WHERE key IN (${placeholders})
        AND (value GLOB '[0-9]' OR value GLOB '[0-9][0-9]')
        AND CAST(value AS INTEGER) BETWEEN 0 AND 23`
  ).run(...HOUR_KEYS);
}

export const migration: Migration = {
  id: 158,
  name: "158-notify-times-minute-grain",
  up,
};
