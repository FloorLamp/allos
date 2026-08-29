import { db } from "@/lib/db";
import { getTravelSwitches } from "@/lib/settings/travel";
import { isEditLocked } from "./sync-log";
import {
  departedZones,
  rekeyedDaysFor,
  type DepartedZone,
} from "./body-metric-rekey";
import type { NormBodyMetric } from "./normalize";

// THE INGEST-SIDE RECONCILE for body_metrics measures a timezone change re-keyed (#3524).
//
// REPLACES `sweepIngestWindowForTimezoneChange`, which is gone along with its three call
// sites (travel accept, the Settings profile form, onboarding). Those paths now delete
// NOTHING. Why, in one line: the sweep deleted a trailing window of Health Connect rows
// on every zone change and trusted the next push to put them back, the exporter re-sends
// one day rather than three, and four days of a production profile's resting HR were
// destroyed across two travel switches. The full argument, and why no day-range bound
// escapes the trade, is in lib/integrations/body-metric-rekey.ts.
//
// THE UNIT IS THE MEASURE, NOT THE ROW. `body_metrics` is one WIDE row per
// (profile, day, source) carrying `weight_kg`, `body_fat_pct` AND `resting_hr` — three
// measures taken at up to three different instants. An earlier draft of this module
// DELETED that row to re-key one measure, so an ordinary push of a single
// resting-heart-rate record destroyed the same day's weigh-in, which Health Connect
// (push-only) never re-sends: #3524's own harm at a finer granularity. So each incoming
// MEASURE is reconciled against its OWN instant, and what it can do to a stored row is
// to NULL ONE COLUMN. The row is dropped only when it holds no measure at all.
//
// WHAT RUNS, per incoming measure `m` with instant `t` and current-zone day `D`:
//
//   for each zone Z the profile has left with `switchedAt > t`, let `D' = day(t, Z)`;
//   if `D' ≠ D`, and the Health Connect row at `D'` HOLDS `m`, and it is not
//   edit-locked, and the upsert accepted `D` → null `m` at `D'`, and drop that row if
//   nulling it left no measure behind.
//
// THE UPSERT AT `D` MERGES, so a measure this push does not carry is never blanked, at
// `D` or at `D'`. The seeded `{ weight 70.2, rhr 60 }` on 08-20 becomes
// `{ weight 70.2 }` on 08-20 and `{ rhr 60 }` on 08-19.
//
// AN UNATTENDED WRITE TO HEALTH ROWS, and it inherits that status from the module it
// replaces. Every narrowing is load-bearing, so each is stated with what it refuses:
//
//   • THE NULL AT `D'` HAPPENS ONLY AFTER THE UPSERT ACCEPTS `D` (owner ruling, #3524,
//     2026-08-23). Its two refusal shapes need separate observations. A TOMBSTONED
//     destination (a day the person deleted) suppresses the insert, so there is no live
//     row at `D`; `!dest` closes that route. An EDIT-LOCKED destination still exists and
//     can hold the person's hand-corrected measure, so its own `isEditLocked` clause
//     closes that route. Once those two shapes are excluded, `upsertBodyMetrics` proves
//     the incoming non-null measure is present: an insert stores it, a merge fills or
//     overwrites it, and an unchanged result means the pre-image already held the
//     resolved post-image. There is no third destination-value refusal to check. The
//     value at `D` need not equal this push's value — #606's partial-day rule can keep a
//     fuller stored average there, and the day still holds the measure either way.
//
//   • EDIT-LOCKED VICTIM ROWS ARE KEPT (#133). A row the user hand-corrected through the
//     Review resolver is not the source's to withdraw: the re-push would re-insert it
//     WITHOUT the correction. Same rule the sweep had, and the same rule
//     `upsertBodyMetrics` applies on the other side.
//
//   • THIS SOURCE ONLY. Withings and Oura attribute each reading using the DEVICE's own
//     zone, so a profile-timezone change does not re-key their rows and there is nothing
//     of theirs to reconcile. Manual rows (`source IS NULL`) are never touched by an
//     ingest path at all.
//
//   • A (DAY, MEASURE) THIS PUSH IS ITSELF WRITING IS NEVER A VICTIM. The ingest path
//     writes body metrics in bounded chunks, so a `(date, column)` this reconcile would
//     null could have been LANDED by an earlier chunk of the same push. Excluding every
//     pair the push carries makes the result independent of the chunk split, which is
//     what lets this stay inline in the ordinary upsert transaction instead of needing a
//     plan/apply split of its own. It is a (day, measure) pair and not a whole day
//     because the unit here is the measure throughout: a push that re-sends a weight for
//     `D'` does not protect a stale resting HR sitting beside it.
//
// KNOWN RESIDUE, stated rather than left to be discovered. Two readings of the same kind
// on one local day (two weigh-ins) collapse to one value, and only the winning value's
// instant is carried — so if that day's readings straddle local midnight in the departed
// zone, the losing reading's stale row is left in place. That residue is a DUPLICATE,
// never a loss, and it is the direction this whole change chooses on purpose.

// The three measures, each with the incoming field that states ITS instant. The stored
// column and the parser's instant field are named together here so a fourth measure
// cannot be added to one without the other.
const MEASURES = [
  { column: "weight_kg", instant: "weight_at" },
  { column: "body_fat_pct", instant: "body_fat_at" },
  { column: "resting_hr", instant: "resting_hr_at" },
] as const;

type MeasureColumn = (typeof MEASURES)[number]["column"];

interface StoredRow {
  edited: number | null;
  weight_kg: number | null;
  body_fat_pct: number | null;
  resting_hr: number | null;
}

// A (day, measure) pair, for the exclusion above. `#` cannot occur in either half — the
// date is `YYYY-MM-DD` and the column names are the three literals above.
const pairKey = (date: string, column: MeasureColumn) => `${date}#${column}`;

// Every (date, measure) this push writes. Computed over the WHOLE push, not the current
// chunk — see the exclusion above.
export function pushedMeasures(rows: readonly NormBodyMetric[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows)
    for (const m of MEASURES)
      if (r[m.column] != null) out.add(pairKey(r.date, m.column));
  return out;
}

export interface ReconcileOptions {
  // Every (date, measure) the WHOLE push carries, so a chunk cannot null a sibling
  // chunk's write. Defaults to the pairs in `rows` — correct whenever the caller is not
  // chunking.
  pushed?: ReadonlySet<string>;
  // Injected in tests; production reads the profile's recorded switch history.
  departed?: readonly DepartedZone[];
}

// Withdraw the old key of every measure this push re-keyed. Runs inside the caller's
// write transaction, AFTER the upsert that lands the measures — `body_metrics` is one
// row per day per source and a Health Connect body-metric push is a handful of rows, so
// there is nothing here that needs a transaction of its own (owner ruling on #3524:
// deliberately NOT coupled to #3424's transaction mechanics).
//
// Returns how many stored measures it cleared. Profile-scoped.
export function reconcileRekeyedBodyMetrics(
  profileId: number,
  rows: readonly NormBodyMetric[],
  source: string,
  opts: ReconcileOptions = {}
): number {
  const departed = opts.departed ?? departedZones(getTravelSwitches(profileId));
  if (departed.length === 0) return 0;
  const pushed = opts.pushed ?? pushedMeasures(rows);
  // Prepared per call, like every other statement on this path: the DB tests swap the
  // connection under the module, and a statement compiled at import time would outlive
  // it.
  const findRow = db.prepare(
    `SELECT edited, weight_kg, body_fat_pct, resting_hr FROM body_metrics
      WHERE profile_id = ? AND date = ? AND source IS ? ORDER BY id LIMIT 1`
  );
  // One statement per measure, so the column being nulled is a literal from MEASURES and
  // never anything a payload can reach.
  const clear = new Map(
    MEASURES.map((m) => [
      m.column,
      db.prepare(
        `UPDATE body_metrics SET ${m.column} = NULL
          WHERE profile_id = ? AND date = ? AND source IS ?`
      ),
    ])
  );
  const dropEmpty = db.prepare(
    `DELETE FROM body_metrics WHERE profile_id = ? AND date = ? AND source IS ?`
  );
  const stored = (date: string) =>
    findRow.get(profileId, date, source) as StoredRow | undefined;

  let cleared = 0;
  for (const row of rows) {
    for (const m of MEASURES) {
      if (row[m.column] == null) continue;
      const iso = row[m.instant];
      // No stated instant, nothing to reconcile: the day attribution is all we have and
      // it is the same question the upsert is already answering.
      if (!iso) continue;
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) continue;
      const victims = rekeyedDaysFor(at, row.date, departed).filter(
        (v) => !pushed.has(pairKey(v.date, m.column))
      );
      if (victims.length === 0) continue;
      // Read `D` back after the upsert. A tombstone leaves no live row; an edit lock
      // leaves a live row that must be refused explicitly. Otherwise the upsert's
      // insert/merge/unchanged postconditions already prove this non-null measure is
      // present, so a destination-value check would only repeat prior control flow.
      const dest = stored(row.date);
      if (!dest || isEditLocked(dest.edited)) continue;
      for (const victim of victims) {
        const was = stored(victim.date);
        if (!was || isEditLocked(was.edited) || was[m.column] == null) continue;
        clear.get(m.column)?.run(profileId, victim.date, source);
        cleared++;
        // The row held this measure and nothing else: it is empty now, and an empty row
        // would sit in Trends and in every export as a day with no reading.
        const holdsMore = MEASURES.some(
          (other) => other.column !== m.column && was[other.column] != null
        );
        if (!holdsMore) dropEmpty.run(profileId, victim.date, source);
      }
    }
  }
  return cleared;
}
