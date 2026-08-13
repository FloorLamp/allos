import { hoistedStatement } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  LOG_HABIT_WINDOW_DAYS,
  type LogSegmentId,
  type SegmentLogDays,
} from "@/lib/log-sheet";

// THE "MOST-LOGGED DOMAIN" GATHER (issue #2709) — the data half of the dashboard
// sheet's opening segment. `lib/log-sheet.ts` owns the decision, the window, the
// evidence floor and the churn argument; this module only counts.
//
// ── WHAT IT COUNTS, AND WHY THAT AND NOT ROWS ────────────────────────────────
//
// DISTINCT DAYS on which the segment was logged at all, over the trailing
// `LOG_HABIT_WINDOW_DAYS`. The day grain is the stabiliser the ruling asked for
// (the argument is in the decision module): a rows measure would let one evening
// of six food taps outweigh a fortnight of morning weigh-ins, and would move the
// opening segment on a burst.
//
// ── AND WHY MANUAL ROWS ONLY ─────────────────────────────────────────────────
//
// The question is which domain this PERSON reaches the sheet for, so an ingested
// row is no evidence about it. Every store that can tell a hand-entered row from a
// synced one is filtered to the hand-entered half. Without that filter one
// connected wearable — pushing sleep, HRV and resting heart rate every night,
// unattended — would pin the answer to Body forever and no amount of tapping could
// move it, which is the opposite of adapting to what somebody logs.
//
// ── "HAND-ENTERED" IS SPELLED PER COLUMN, NOT ONCE ─────────────────────────────
//
// Three arms below spell it three ways, and that is a property of the COLUMNS
// rather than an inconsistency to tidy. Each arm's predicate is read off its own
// store's writers, because a predicate that disagrees with its writer counts
// nothing while still reading like a filter — which is exactly what this
// statement did until #2720: `medical_records` was filtered on `source IS NULL`
// while `insertVitals`, the core behind the sheet's own "Log measurements" entry,
// stamps `source = 'manual'` through `recordReading`. The store added so that a
// blood-pressure logger would not be under-counted counted that logger at zero.
//
//   activities / body_metrics / practice_logs — `source IS NULL`. The column is
//     nullable and every manual writer omits it (`saveActivityCore`,
//     `insertBodyMetric`, `logPracticeSession`); only an integration binds it.
//   metric_samples — `source = 'manual'`. The column is NOT NULL, so there is no
//     null half to admit and `OR source IS NULL` here would be dead SQL. Its one
//     manual writer, `upsertManualSample`, always stamps 'manual'.
//   medical_records — `source IS NULL OR source = 'manual'`. Nullable AND written
//     by hand-entry paths that disagree: `insertVitals`/`recordReading` and the
//     temperature logger stamp 'manual', while the /results "add a result" form
//     leaves it NULL. Both are a person typing, so both count, and nothing synced
//     slips in — the integration vitals writer always binds its source id, and an
//     imported reading is already excluded by `document_id IS NULL`.
//
// ── ONE STATEMENT, HOISTED, AND WRITTEN OUT IN FULL ──────────────────────────
//
// It is read once per app-shell render — the hottest path there is — so it is a
// single UNION ALL compiled once per connection (`hoistedStatement`) rather than
// eight prepares per request. It is also ONE LITERAL rather than a registry
// assembled at runtime, deliberately: the owned-table scans read prepare
// arguments as TEXT, and SQL composed out of fragments passes those scans by
// being invisible to them. Every arm therefore names its own profile filter here,
// where the scan can see it — including `intake_item_logs`, which has no
// profile_id of its own and scopes through its parent item as it does everywhere
// else.

// Every day-producing arm, tagged with the segment it counts toward. Which stores
// answer for which quick-log entry is DECLARED in `LOG_DAY_SOURCES`
// (lib/log-sheet.ts, pure so the census can be read without a database), and
// `lib/__tests__/log-sheet-sources.test.ts` holds this statement to it in both
// directions — a declared store that is not counted, and a counted store that was
// never declared, each fail.
const HABIT_DAYS = hoistedStatement(
  `SELECT segment, COUNT(DISTINCT d) AS days FROM (
     SELECT 'train' AS segment, date AS d FROM activities
       WHERE profile_id = @profileId AND source IS NULL AND date >= @from
     UNION ALL
     SELECT 'food' AS segment, date AS d FROM food_log
       WHERE profile_id = @profileId AND date >= @from
     UNION ALL
     SELECT 'body' AS segment, date AS d FROM body_metrics
       WHERE profile_id = @profileId AND source IS NULL AND date >= @from
     UNION ALL
     SELECT 'body' AS segment, date AS d FROM metric_samples
       WHERE profile_id = @profileId AND source = 'manual' AND date >= @from
     UNION ALL
     SELECT 'body' AS segment, date AS d FROM medical_records
       WHERE profile_id = @profileId AND category = 'vitals'
         AND document_id IS NULL
         AND (source IS NULL OR source = 'manual')
         AND date >= @from
     UNION ALL
     SELECT 'body' AS segment, period_start AS d FROM cycles
       WHERE profile_id = @profileId AND period_start >= @from
     UNION ALL
     SELECT 'care' AS segment, l.date AS d FROM intake_item_logs l
       JOIN intake_items ii ON ii.id = l.item_id
      WHERE ii.profile_id = @profileId AND l.date >= @from
     UNION ALL
     SELECT 'care' AS segment, date AS d FROM practice_logs
       WHERE profile_id = @profileId AND source IS NULL AND date >= @from
   ) WHERE d IS NOT NULL AND d != ''
   GROUP BY segment`
);

/**
 * How many DAYS in the trailing `LOG_HABIT_WINDOW_DAYS` this profile logged each
 * segment on. `today` is the profile's own local day, resolved by the caller.
 *
 * Read-only and side-effect free. The decision over it is `openingLogSegment`
 * (lib/log-sheet.ts), which is where the window, the floor and the fallback live.
 */
export function getSegmentLogDays(
  profileId: number,
  today: string
): SegmentLogDays {
  const rows = HABIT_DAYS.all({
    profileId,
    from: shiftDateStr(today, -(LOG_HABIT_WINDOW_DAYS - 1)),
  }) as { segment: LogSegmentId; days: number }[];
  const out: Partial<Record<LogSegmentId, number>> = {};
  for (const r of rows) out[r.segment] = r.days;
  return out;
}
