import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { HEALTH_CONNECT_ID } from "./health-connect";

// Days back to sweep — the Health Connect exporter re-sends a rolling ~48h window; a
// 3-day bound covers it with margin while never touching older rows (which won't be
// re-pushed, so deleting them would lose data).
const SWEEP_DAYS = 3;

// Sweep the current rolling-window ingest rows that key on PROFILE-LOCAL time computed
// at ingest, after the profile's timezone changed (#608).
//
// ONE table does this now: body_metrics — UNIQUE (profile_id, date, source) where
// `date` is computed in the profile timezone at ingest FOR HEALTH CONNECT. An evening
// weigh-in re-attributes to the adjacent local day and inserts a second row while the
// old one persists.
//
// hr_minutes USED TO BE THE OTHER HALF, and is deliberately gone (#2205, migration
// 164). Its `ts` was the profile-local minute at ingest and part of the primary key, so
// a timezone change re-labelled which minute a re-pushed sample landed on and the next
// rolling-window push inserted ~48h of shifted duplicates. `ts` is an absolute instant
// now, the key no longer moves when the timezone does, and there is nothing left to
// sweep. THIS HALF EXISTED BECAUSE OF THAT WEAKNESS; THE WEAKNESS IS GONE; THEREFORE
// THE HALF IS GONE.
//
// The body_metrics half is NOT the same situation and must stay. `body_metrics.date` is
// a profile-local DAY, which #2205 leaves untouched by definition (its constraint 4:
// day attribution is a different question from an instant), so that key still moves
// with the timezone and the duplicate weigh-in it prevents is a live bug. DELETING IT
// WOULD BE REINTRODUCING A BUG UNDER COVER OF A CLEANUP.
//
// Only Health Connect keys on the profile timezone — Withings and Oura attribute each
// reading using the DEVICE's own zone, so a profile-tz change does not re-key their
// rows and they are left alone. Deleting the current window's HC rows lets the next
// push (within minutes) repopulate them cleanly under the new keys. Edit-locked
// body_metrics rows are KEPT: a re-push would re-insert them WITHOUT the user's
// hand-correction, so sweeping them would silently lose the edit. Returns the delete
// count. Profile-scoped.
export function sweepIngestWindowForTimezoneChange(profileId: number): {
  bodyMetrics: number;
} {
  // `date` is 'YYYY-MM-DD', so a lexicographic `>= cutoff` bounds the trailing window.
  const cutoff = shiftDateStr(today(profileId), -SWEEP_DAYS);
  const bodyMetrics = db
    .prepare(
      `DELETE FROM body_metrics
        WHERE profile_id = ? AND source = ? AND date >= ?
          AND (edited IS NULL OR edited = 0)`
    )
    .run(profileId, HEALTH_CONNECT_ID, cutoff).changes;
  return { bodyMetrics };
}
