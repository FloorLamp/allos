import { db } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { getTravelSwitches } from "@/lib/settings/travel";
import {
  departedZones,
  rekeyedDaysFor,
  type DepartedZone,
} from "./body-metric-rekey";
import type { NormBodyMetric } from "./normalize";

// THE INGEST-SIDE RECONCILE for body_metrics rows a timezone change re-keys (#3524).
//
// REPLACES `sweepIngestWindowForTimezoneChange`, which is gone along with its three call
// sites (travel accept, the Settings profile form, onboarding). Those paths now delete
// NOTHING. Why, in one line: the sweep deleted a trailing window of Health Connect rows
// on every zone change and trusted the next push to put them back, the exporter re-sends
// one day rather than three, and four days of a production profile's resting HR were
// destroyed across two travel switches. The full argument, and why no day-range bound
// escapes the trade, is in lib/integrations/body-metric-rekey.ts.
//
// WHAT RUNS INSTEAD. Per incoming Health Connect body-metric row, at ingest: the row
// carries the instant it was measured and the day it files under in the profile's
// CURRENT zone; for each zone the profile recently left, ask which day that same instant
// filed under THERE, and delete the row sitting on that day. That is the row the push is
// about to re-key, and nothing else — a day the exporter does not re-send has no
// incoming instant, so nothing computes a day for it and nothing touches it.
//
// AN UNATTENDED DELETE OF HEALTH ROWS, and it inherits that status from the module it
// replaces. Every narrowing below is load-bearing, so each one is stated with what it
// refuses:
//
//   • EDIT-LOCKED ROWS ARE KEPT (#133). A row the user hand-corrected through the Review
//     resolver is not the source's to withdraw: the re-push would re-insert it WITHOUT
//     the correction, so deleting it would silently lose the edit. Same rule the sweep
//     had, and the same rule `upsertBodyMetrics` applies on the other side.
//
//   • THIS SOURCE ONLY. Withings and Oura attribute each reading using the DEVICE's own
//     zone, so a profile-timezone change does not re-key their rows and there is nothing
//     of theirs to reconcile. Manual rows (`source IS NULL`) are never touched by an
//     ingest path at all.
//
//   • A DAY THIS PUSH IS ITSELF WRITING IS NEVER A VICTIM. Two reasons, and the first
//     one is a correctness requirement rather than a preference. (a) ORDER: the ingest
//     path writes body metrics in bounded chunks, so a date this reconcile deletes could
//     have been written by an EARLIER chunk of the same push — deleting it would drop a
//     row the push had already landed. Excluding every date the push carries makes the
//     reconcile independent of the chunk split, which is what lets it stay inline in the
//     ordinary upsert transaction instead of needing a plan/apply split of its own.
//     (b) LOSS: the stored row on that day may hold a measure this push does not carry
//     (a weigh-in from a source day the push only re-sends resting HR for). The upsert
//     merges into it; a delete would throw it away. Skipping keeps it, and the only
//     residue is a duplicate the NEXT push collapses.
//
// KNOWN RESIDUE, stated rather than left to be discovered. `body_metrics` is one WIDE row
// per (profile, day, source) that can carry weight, body fat and resting HR from
// DIFFERENT instants, while the reconcile keys on one instant per day — the latest, which
// is the one `occurred_at` records and the one the day's weight is taken from. A day
// whose measures straddle local midnight in the departed zone therefore reconciles only
// the stamped instant's row, and an earlier measure's stale row is left in place. That
// residue is a possible DUPLICATE, never a loss, and it is the direction this whole
// change is choosing on purpose.

// Every date this push writes. Computed over the WHOLE push, not the current chunk —
// see (a) above.
export function pushedDates(rows: readonly NormBodyMetric[]): Set<string> {
  return new Set(rows.map((r) => r.date));
}

export interface ReconcileOptions {
  // Every date the WHOLE push carries, so a chunk cannot delete a sibling chunk's write.
  // Defaults to the dates of `rows` — correct whenever the caller is not chunking.
  pushDates?: ReadonlySet<string>;
  // Injected in tests; production reads the profile's recorded switch history.
  departed?: readonly DepartedZone[];
  now?: Date;
}

// Delete the rows this push re-keys. Runs inside the caller's write transaction —
// `body_metrics` is one row per day per source and a Health Connect body-metric push is
// a handful of rows, so there is nothing here that needs a transaction of its own
// (owner ruling on #3524: deliberately NOT coupled to #3424's transaction mechanics).
//
// Returns how many rows it deleted. Profile-scoped.
export function reconcileRekeyedBodyMetrics(
  profileId: number,
  rows: readonly NormBodyMetric[],
  source: string,
  opts: ReconcileOptions = {}
): number {
  const now = opts.now ?? clockNow();
  const departed =
    opts.departed ?? departedZones(getTravelSwitches(profileId), now);
  if (departed.length === 0) return 0;
  const pushDates = opts.pushDates ?? pushedDates(rows);
  // Prepared per call, like every other statement on this path: the DB tests swap the
  // connection under the module, and a statement compiled at import time would outlive it.
  const deleteRekeyed = db.prepare(
    `DELETE FROM body_metrics
       WHERE profile_id = ? AND source IS ? AND date = ?
         AND (edited IS NULL OR edited = 0)`
  );
  let deleted = 0;
  for (const row of rows) {
    // No stated instant, nothing to reconcile: the day attribution is all we have and it
    // is the same question the upsert is already answering.
    if (!row.measured_at) continue;
    const at = new Date(row.measured_at);
    if (Number.isNaN(at.getTime())) continue;
    for (const victim of rekeyedDaysFor(at, row.date, departed)) {
      if (pushDates.has(victim.date)) continue;
      deleted += deleteRekeyed.run(profileId, source, victim.date).changes;
    }
  }
  return deleted;
}
