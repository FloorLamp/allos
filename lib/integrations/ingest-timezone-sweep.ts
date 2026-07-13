import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { HEALTH_CONNECT_ID } from "./health-connect";

// Days back to sweep — the Health Connect exporter re-sends a rolling ~48h window; a
// 3-day bound covers it with margin while never touching older rows (which won't be
// re-pushed, so deleting them would lose data).
const SWEEP_DAYS = 3;

// Sweep the current rolling-window ingest rows that key on PROFILE-LOCAL time computed
// at ingest, after the profile's timezone changed (#608). Two tables do this:
//
//  • hr_minutes — PRIMARY KEY (profile_id, ts, source) where `ts` is the profile-local
//    minute at ingest (#94). A timezone change re-labels which local minute a re-pushed
//    raw sample lands on, so without a sweep the next rolling-window push INSERTS ~48h
//    of shifted duplicates alongside the old rows, inflating HR-series / training-zone
//    reads.
//  • body_metrics — UNIQUE (profile_id, date, source) where `date` is computed in the
//    profile timezone at ingest FOR HEALTH CONNECT. An evening weigh-in re-attributes
//    to the adjacent local day and inserts a second row while the old persists.
//
// Only Health Connect keys on the profile timezone — Withings and Oura attribute each
// reading using the DEVICE's own zone, so a profile-tz change does not re-key their
// rows and they are left alone. Deleting the current window's HC rows lets the next
// push (within minutes) repopulate them cleanly under the new keys. Edit-locked
// body_metrics rows are KEPT: a re-push would re-insert them WITHOUT the user's
// hand-correction, so sweeping them would silently lose the edit. Returns the per-table
// delete counts. Profile-scoped.
export function sweepIngestWindowForTimezoneChange(profileId: number): {
  hrMinutes: number;
  bodyMetrics: number;
} {
  // ts is 'YYYY-MM-DDTHH:MM' and date is 'YYYY-MM-DD', so a lexicographic `>= cutoff`
  // (a bare date) bounds both to the trailing window.
  const cutoff = shiftDateStr(today(profileId), -SWEEP_DAYS);
  const hrMinutes = db
    .prepare(
      "DELETE FROM hr_minutes WHERE profile_id = ? AND source = ? AND ts >= ?"
    )
    .run(profileId, HEALTH_CONNECT_ID, cutoff).changes;
  const bodyMetrics = db
    .prepare(
      `DELETE FROM body_metrics
        WHERE profile_id = ? AND source = ? AND date >= ?
          AND (edited IS NULL OR edited = 0)`
    )
    .run(profileId, HEALTH_CONNECT_ID, cutoff).changes;
  return { hrMinutes, bodyMetrics };
}
