import type Database from "better-sqlite3";
import type { Migration } from "../runner";
import {
  hhmmToMinutes,
  isDstTransitionDay,
  parseUtcSql,
  zonedDateParts,
} from "../../date";
import { resolveTimezone } from "../../timezone";
import {
  arrivalStatistics,
  DIGEST_DEFAULT_MINUTE,
  type ArrivalNight,
} from "../../notifications/digest-schedule";
import { formatNotifyTime } from "../../notifications/schedule";

// Migration 166 (issue #2211): the morning digest gets a MODE, and the `auto`
// sentinel leaves `notify_digest_hour`.
//
// The digest used to have three states in one key — absent/"" (off), "HH:MM"
// (manual), and "auto" (follow the wake-derived time). `auto` did two jobs at once
// ("pick my time" AND "make my digest complete"), which is what made a typed time
// unable to wait and an `auto` time silently wander. It is replaced by two modes
// carried in their own key:
//
//   digest_mode = 'static'   — "Same time every day"   (today's behavior)
//   digest_mode = 'dynamic'  — "As soon as it's ready" (new, opt-in)
//
// THE RULE THIS MIGRATION OBEYS: the mode is new, so NO USER'S DIGEST MAY MOVE AND
// NONE MAY TURN ON. Everything configured becomes STATIC, and nothing that was off
// becomes on. Dynamic is reachable only by a tap in Settings (#2211 constraint 3).
//
//   stored `HH:MM`  → Static at HH:MM, byte-for-byte unchanged
//   stored `auto`   → Static at a concrete minute, resolved ONCE, here (below)
//   stored `""`     → Off. No mode row: there is no digest to have a mode.
//   absent          → Off, and nothing is written. The digest is opt-in and absent
//                     has always meant off; writing a mode for a profile with no
//                     digest would be inventing configuration nobody asked for.
//
// RESOLVING `auto`. Its live value was the arrival p90 plus one minute — the first
// minute strictly after last night's sleep typically LANDS — falling back to the
// wake time when the arrival sample could not answer. This migration reproduces the
// first half exactly, running the same provenance join and the same pure
// `arrivalStatistics` the reader used, and deliberately does NOT reproduce the wake
// fallback:
//
//   • the wake time is the measured DEFECT (#2214: a wake-scheduled digest had last
//     night in hand on 0 of 11 mornings, by construction, because the row lands ~70
//     minutes behind waking), and
//   • it drifts on its own — median wake moved 05:34 → 05:53 across three weekly
//     steps — so there is no stable value to freeze in the first place.
//
// Freezing a known-wrong, self-moving number forever is worse than the declared
// default the picker itself pre-fills, so a profile whose arrival sample has no
// answer becomes Static at DIGEST_DEFAULT_MINUTE (07:00) and #2217 is what corrects
// it, with a tap, once there is evidence.
//
// DETERMINISM. Reads only the DB and its own constants. The timestamp and timezone
// helpers are pure (migration 164 already imports the same family for the same
// reason); the percentile is pure. The overnight-duration floor is COPIED here
// rather than imported from lib/queries/metrics.ts on purpose: a shipped migration
// is frozen, and it must keep converting exactly as it did on the day it ran even
// if the live gather's constant is later retuned.
//
// Replay-safe: the `auto` conversion targets only the literal string `auto`, which
// it replaces with an "HH:MM" that never matches again, and the mode write is an
// insert-if-absent — so a re-run can neither move a converted time nor reset a mode
// the user has since chosen.

// The duration (minutes) at/above which a sleep sample counts as an overnight for
// arrival purposes — lib/queries/metrics.ts's ARRIVAL_LAG_MIN_OVERNIGHT_MIN as it
// stood when this migration shipped. See the determinism note above.
const OVERNIGHT_MIN = 180;
// How many recent nights the live gather reads. Same reason.
const LIMIT_NIGHTS = 30;

const DIGEST_HOUR_KEY = "notify_digest_hour";
const DIGEST_MODE_KEY = "digest_mode";

interface ArrivalRow {
  endTime: string | null;
  arrivedAt: string | null;
}

function profileTimezone(db: Database.Database, profileId: number): string {
  const prof = (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'"
      )
      .get(profileId) as { value?: string } | undefined
  )?.value;
  const instance = prof
    ? undefined
    : (
        db
          .prepare("SELECT value FROM settings WHERE key = 'timezone'")
          .get() as { value?: string } | undefined
      )?.value;
  return resolveTimezone(prof, instance);
}

// The same rows `getSleepArrivals` reads: each recent overnight sleep sample paired
// with the first moment its provenance row appeared.
function arrivalNights(
  db: Database.Database,
  profileId: number
): ArrivalNight[] {
  const tz = profileTimezone(db, profileId);
  const rows = db
    .prepare(
      `SELECT ms.end_time AS endTime, MIN(r.created_at) AS arrivedAt
         FROM metric_samples ms
         JOIN integration_sync_rows r
           ON r.target_table = 'metric_samples' AND r.target_id = ms.id
        WHERE ms.profile_id = ?
          AND ms.metric = 'sleep_min'
          AND ms.start_time IS NOT NULL
          AND ms.end_time IS NOT NULL
          AND julianday(ms.end_time) > julianday(ms.start_time)
          AND ms.value >= ?
        GROUP BY ms.id
        ORDER BY ms.date DESC
        LIMIT ?`
    )
    .all(profileId, OVERNIGHT_MIN, LIMIT_NIGHTS) as ArrivalRow[];
  return rows.flatMap((r) => {
    const ended = parseUtcSql(r.endTime);
    const arrived = parseUtcSql(r.arrivedAt);
    if (!ended || !arrived) return [];
    const { date, hhmm } = zonedDateParts(tz, arrived);
    return [
      {
        date,
        arrivalMinute: hhmmToMinutes(hhmm),
        lagMin: Math.round((arrived.getTime() - ended.getTime()) / 60000),
        dstTransition: isDstTransitionDay(tz, date),
      },
    ];
  });
}

// What this profile's `auto` digest resolves to, once and for good.
function resolveAuto(db: Database.Database, profileId: number): number {
  const stats = arrivalStatistics(arrivalNights(db, profileId));
  // "Strictly after" (the +1) is the live resolution's rule and survives: a digest
  // scheduled for the same minute the data typically lands is a race it loses half
  // the time.
  return stats.available ? stats.p90Minute + 1 : DIGEST_DEFAULT_MINUTE;
}

export function up(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT profile_id AS profileId, value
         FROM profile_settings
        WHERE key = ?`
    )
    .all(DIGEST_HOUR_KEY) as { profileId: number; value: string }[];

  // DO NOTHING, not DO UPDATE: the mode is USER-OWNED, so a re-run must never
  // reset a mode someone has since tapped back to Static.
  const setMode = db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT(profile_id, key) DO NOTHING`
  );
  const setHour = db.prepare(
    `UPDATE profile_settings SET value = ? WHERE profile_id = ? AND key = ?`
  );

  for (const row of rows) {
    const raw = (row.value ?? "").trim();
    // Off keeps no mode: there is no digest for a mode to describe, and writing one
    // would be the "absent must not turn anything on" rule broken from the side.
    if (raw === "") continue;
    if (raw === "auto") {
      setHour.run(
        formatNotifyTime(resolveAuto(db, row.profileId)),
        row.profileId,
        DIGEST_HOUR_KEY
      );
    }
    setMode.run(row.profileId, DIGEST_MODE_KEY, "static");
  }
}

export const migration: Migration = {
  id: 166,
  name: "166-digest-mode",
  up,
};
