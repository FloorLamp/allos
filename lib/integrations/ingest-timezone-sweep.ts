import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { HEALTH_CONNECT_ID } from "./health-connect";

// Days back to sweep, from TODAY IN THE NEW ZONE. This is a statement about what the
// Health Connect exporter re-sends, not a margin. Only a re-sent instant can be
// re-keyed, so a day the exporter never re-sends has no duplicate to prevent and
// deleting it is pure loss — #3524, where this constant was 3 and two travel switches
// destroyed four days of a profile's resting HR on prod.
//
// WHAT THE EXPORTER RE-SENDS. Health Connect is a PUSH source here (registry.ts:
// kind "push", no `pull` facet), so Allos never fetches from the phone and the ONLY
// thing that can repopulate a swept row is the next push. #3524's census of the
// retained prod payloads (data/integration-payloads/, the newest KEEP_PER_SOURCE = 50
// pushes over 2026-08-20/21) found every push carrying exactly ONE
// `resting_heart_rate` record, today's: 49 of 50 covered a single local day and one
// covered two across the day rollover. Reading the exporter's own window confirmed it
// holds at most two days of resting HR at a time, never three. So the instants a push
// can re-key lie on TODAY in the new zone and — at a rollover — yesterday.
//
// WHY NOT 0. Moving EAST re-keys a reading FORWARD a day: a weigh-in at 21:30 in Los
// Angeles on the 1st is 00:30 in New York on the 2nd, so after the switch the re-push
// files it on the 2nd while the row stored before the switch sits on the 1st —
// today − 1. That stale row IS #608's duplicate, and a sweep starting at today would
// leave it standing.
//
// WHY THE WINDOW IS ASYMMETRIC — READ THIS BEFORE ADDING AN UPPER BOUND. Moving WEST
// re-keys BACKWARD, and then the stale row sits on a day that is still in the FUTURE
// in the new zone. Switch New York → Honolulu at 05:00Z: New York reads 01:00 on the
// 22nd, so a reading minutes old was stored on the 22nd, while Honolulu reads 19:00 on
// the 21st and today is the 21st. The DELETE below is `date >= cutoff` with NO upper
// bound ON PURPOSE — that is what reaches the 22nd. A tidier-looking
// `BETWEEN cutoff AND today` would silently reintroduce the westward half of #608.
//
// WHAT THIS DELIBERATELY DOES NOT COVER: a rollover push carries yesterday's record
// too, so after an eastward move it can leave a stale row on today − 2. Covering that
// would mean deleting today − 2 on EVERY switch to pre-empt a case needing both a
// rollover push (1 of 50) and an instant that actually crosses midnight — spending a
// certain day of unrecoverable data against an uncertain duplicate, which is the exact
// trade #3524 was filed about. The row-level answer to that residue is #3524's second
// option (delete the old-day row only when a push really re-keys that instant); it is
// not landed here.
const SWEEP_DAYS = 1;

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
// rows and they are left alone. Deleting the re-sendable window's HC rows lets the
// next push (within minutes) repopulate TODAY cleanly under the new keys; today − 1 is
// re-sent only by a rollover push, so sweeping it is a real cost, paid because the
// eastward re-key above puts #608's duplicate exactly there. Edit-locked
// body_metrics rows are KEPT: a re-push would re-insert them WITHOUT the user's
// hand-correction, so sweeping them would silently lose the edit. Returns the delete
// count. Profile-scoped.
export function sweepIngestWindowForTimezoneChange(profileId: number): {
  bodyMetrics: number;
} {
  // `date` is 'YYYY-MM-DD', so a lexicographic `>= cutoff` bounds the window below.
  // `today()` here is TODAY IN THE NEW ZONE — every caller writes the timezone before
  // calling — and the window is open at the top by design (see SWEEP_DAYS above).
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
