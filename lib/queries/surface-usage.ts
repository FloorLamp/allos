import {
  isDraftActivityRow,
  type DraftCandidateRow,
} from "@/lib/activity-draft";
import { shiftDateStr } from "@/lib/date";
import { hoistedStatement } from "@/lib/db";
import type { LedgerWithLoggedVia, LoggedVia } from "@/lib/logged-via";
import {
  SURFACE_USAGE_WINDOW_DAYS,
  surfaceChannel,
  type SurfaceChannel,
} from "@/lib/surface-usage";

// THE SURFACE-USAGE READ MODEL (issue #4249) — the counting half. The question,
// the window and the surface vocabulary are declared in `lib/surface-usage.ts`;
// this module is the one place that asks the database.
//
// ── WHAT IT RETURNS, AND WHY DAYS AND NOT COUNTS ─────────────────────────────
//
// For each ledger and each surface, the DISTINCT LOCAL DAYS that surface was
// acted on. Days rather than rows for the reason the #2709 measure already gives
// (one evening of six taps is one day's evidence, so a burst cannot move an
// answer), and a SET of days rather than a count because a domain spans several
// ledgers: a consumer asking "how many days did this profile act on the web in
// Consume" must union food, dose and substance days before counting, and two
// counts cannot be unioned after the fact.
//
// THE COST IS ON THE APP-SHELL PATH and is accepted with its size known. The
// statement is grouped in SQL, so what crosses the boundary is one row per
// (ledger, surface, day) — bounded by 90 × the ledgers a profile actually uses,
// a few hundred rows for a heavy logger rather than the thousands of underlying
// events. It is hoisted (`hoistedStatement`) and compiled once per connection.
//
// ── ONE LITERAL, EVERY ARM NAMING ITS OWN PROFILE FILTER ─────────────────────
//
// Written out in full rather than assembled from fragments, for the same reason
// `lib/queries/log-sheet.ts` is: the owned-table scans read prepare arguments as
// TEXT, and SQL composed at runtime passes those scans by being invisible to
// them. `intake_item_logs` has no profile_id of its own and scopes through its
// parent item, as it does everywhere else.
//
// ── WHAT COUNTS AS AN ACT ────────────────────────────────────────────────────
//
// `logged_via IS NOT NULL` on every arm, which is the whole membership rule: a
// row the app cannot attribute to a surface is not evidence about surfaces (see
// `surfaceChannel`'s note on the unbackfilled column). Two ledgers need a clause
// beyond that, and both are about what a ROW IS rather than about any consumer:
//
//   medical_records — `category = 'vitals' AND document_id IS NULL`. The rest of
//     that table is records FILED rather than logged, and a filed record is dated
//     by the DOCUMENT — the day the lab drew the blood, often months before
//     anyone typed it in — so its date says nothing about when its owner acted.
//     A vitals sitting is dated by the sitting.
//   activities — a create-at-start husk is an ADDRESS, not an entry (#3191): the
//     row records a place to log into rather than something that was logged. The
//     rule is `isDraftActivityRow` reading the WHOLE row, which a grouped
//     aggregate cannot show it, so that arm is its own statement and folds in TS.
//     Restating the rule in SQL would be a second definition of a draft.

const ACT_DAYS = hoistedStatement(
  `SELECT ledger, surface, d FROM (
     SELECT 'food_log_events' AS ledger, logged_via AS surface, date AS d
       FROM food_log_events
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
     UNION ALL
     SELECT 'intake_item_logs' AS ledger, l.logged_via AS surface, l.date AS d
       FROM intake_item_logs l
       JOIN intake_items ii ON ii.id = l.item_id
      WHERE ii.profile_id = @profileId AND l.logged_via IS NOT NULL
        AND l.date >= @from
     UNION ALL
     SELECT 'substance_daily_totals' AS ledger, logged_via AS surface, date AS d
       FROM substance_daily_totals
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
     UNION ALL
     SELECT 'substance_log_events' AS ledger, logged_via AS surface, date AS d
       FROM substance_log_events
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
     UNION ALL
     SELECT 'body_metrics' AS ledger, logged_via AS surface, date AS d
       FROM body_metrics
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
     UNION ALL
     SELECT 'medical_records' AS ledger, logged_via AS surface, date AS d
       FROM medical_records
      WHERE profile_id = @profileId AND logged_via IS NOT NULL
        AND category = 'vitals' AND document_id IS NULL AND date >= @from
     UNION ALL
     SELECT 'practice_logs' AS ledger, logged_via AS surface, date AS d
       FROM practice_logs
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
     UNION ALL
     SELECT 'symptom_logs' AS ledger, logged_via AS surface, date AS d
       FROM symptom_logs
      WHERE profile_id = @profileId AND logged_via IS NOT NULL AND date >= @from
   ) WHERE d IS NOT NULL AND d != ''
   GROUP BY ledger, surface, d`
);

// The `activities` arm, kept whole so the draft rule can read the row — see the
// header. It is tagged like every other arm, and its days join the same fold.
const ACTIVITY_ACT_DAYS = hoistedStatement(
  `SELECT 'activities' AS ledger, a.logged_via AS surface, a.date AS d,
          a.start_time, a.end_time, a.duration_min, a.components, a.notes,
          a.distance_km, a.source,
          EXISTS (
            SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
          ) AS has_sets
     FROM activities a
    WHERE a.profile_id = @profileId AND a.logged_via IS NOT NULL
      AND a.date >= @from`
);

/**
 * Which surfaces a profile acted on, per ledger, over the window.
 *
 * `days` is ledger → surface → the distinct profile-local days that surface was
 * acted on. A ledger the profile has never acted in is ABSENT rather than empty,
 * and so is a surface: a missing key reads as no evidence, never as a claim.
 */
export interface SurfaceUsage {
  /** The window that was read, in days, inclusive of `through`. */
  readonly windowDays: number;
  /** The oldest profile-local day inside the window. */
  readonly from: string;
  /** The newest — the profile's own today, as the caller resolved it. */
  readonly through: string;
  readonly days: ReadonlyMap<
    LedgerWithLoggedVia,
    ReadonlyMap<LoggedVia, ReadonlySet<string>>
  >;
}

function record(
  into: Map<LedgerWithLoggedVia, Map<LoggedVia, Set<string>>>,
  ledger: LedgerWithLoggedVia,
  surface: LoggedVia,
  day: string
): void {
  const bySurface = into.get(ledger) ?? new Map<LoggedVia, Set<string>>();
  const days = bySurface.get(surface) ?? new Set<string>();
  days.add(day);
  bySurface.set(surface, days);
  into.set(ledger, bySurface);
}

/**
 * Read this profile's surface usage. `today` is the profile's own local day,
 * resolved by the caller; `windowDays` defaults to this model's own declared
 * window and is passed explicitly by consumers that declare their own.
 *
 * Read-only and side-effect free. Nothing here is stored, sent, or shown to
 * anybody: the guardrail in `lib/surface-usage.ts` binds every consumer.
 */
export function getSurfaceUsage(
  profileId: number,
  today: string,
  windowDays: number = SURFACE_USAGE_WINDOW_DAYS
): SurfaceUsage {
  const from = shiftDateStr(today, -(windowDays - 1));
  const days = new Map<LedgerWithLoggedVia, Map<LoggedVia, Set<string>>>();
  const rows = ACT_DAYS.all({ profileId, from }) as {
    ledger: LedgerWithLoggedVia;
    surface: LoggedVia;
    d: string;
  }[];
  for (const row of rows) record(days, row.ledger, row.surface, row.d);
  const activityRows = ACTIVITY_ACT_DAYS.all({
    profileId,
    from,
  }) as (DraftCandidateRow & {
    ledger: LedgerWithLoggedVia;
    surface: LoggedVia;
    d: string | null;
    /** 0 or 1 — the draft rule only asks whether ANY set exists. */
    has_sets: number;
  })[];
  for (const row of activityRows) {
    if (!row.d) continue;
    if (isDraftActivityRow(row, row.has_sets)) continue;
    record(days, row.ledger, row.surface, row.d);
  }
  return { windowDays, from, through: today, days };
}

/**
 * The distinct days this profile acted on `channel`, per ledger — the fold nearly
 * every consumer wants, because a consumer asks about a CHANNEL ("do they log
 * here, or in the chat?") rather than about which of four web regions was tapped.
 *
 * Ledgers with no day on that channel are omitted, so a caller reading a missing
 * key gets "no evidence" and never a zero it might mistake for a measurement.
 */
export function channelDays(
  usage: SurfaceUsage,
  channel: SurfaceChannel
): Map<LedgerWithLoggedVia, Set<string>> {
  const out = new Map<LedgerWithLoggedVia, Set<string>>();
  for (const [ledger, bySurface] of usage.days) {
    const days = new Set<string>();
    for (const [surface, surfaceDays] of bySurface) {
      if (surfaceChannel(surface) !== channel) continue;
      for (const day of surfaceDays) days.add(day);
    }
    if (days.size > 0) out.set(ledger, days);
  }
  return out;
}
