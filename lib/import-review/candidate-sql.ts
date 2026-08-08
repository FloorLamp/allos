// The SQL half of the duplicate-candidate PRE-FILTER, in one place (#2056).
//
// Two loaders read the same candidate rows for the same detector — the pruned
// display loader in lib/queries/integrations.ts and the SELECT * auto-merge loader
// in ./auto-merge.ts — and they must agree about which buckets even reach it, or
// Data → Review and the unattended auto-merge see different worlds. They shared the
// simple `date` grouping by copy; the ADJACENT-DAY widening below is subtle enough
// that a second copy of it would be a bug waiting to happen, so it lives here and
// both interpolate it.
//
// PURE: a string, no DB handle, no query. Each loader still spells its own prepared
// statement as a literal template so the profile-scoping scanner can read the
// `profile_id` filters it enforces.

import {
  EVENING_CANDIDATE_CLOCK,
  MORNING_CANDIDATE_CLOCK,
} from "../clock-skew";

// The time-of-day of an activity clock field, as the comparable "HH:MM" the column
// stores. `instr(x, 'T')` is 0 when there is no 'T', so `substr(x, 1)` returns the
// value unchanged — the same tolerance for a stray ISO timestamp that the pure
// `parseMinutesOfDay` carries, expressed once in SQL.
const CLOCK_OF = (col: string) =>
  `substr(substr(${col}, instr(${col}, 'T') + 1), 1, 5)`;

/**
 * The adjacent-day candidate pairs (#2056): two CROSS-SOURCE activities on
 * consecutive days, the earlier starting late enough in the evening and the later
 * early enough in the morning that ONE session pushed across midnight by a wrong UTC
 * offset is the plausible reading.
 *
 * A row set, not a filter: it yields the DATE bucket of BOTH sides, so the loaders
 * can union them into the bucket pre-filter and hand the pure detector rows it can
 * actually pair. The narrowness that matters is downstream — the classifier still
 * demands an offset-SHAPED start gap and agreement on both duration and distance —
 * so this only has to be bounded, and the near-midnight window is what bounds it.
 *
 * NO TYPE JOIN (#2271). This carried `AND l.type = e.type`, which made an INFERRED
 * classification a blocking key: a session Health Connect declined to classify and
 * Strava called `strength` never reached the detector at all. Candidacy is now the
 * date alone; the detector still applies the type gate on its own adjacent-day path,
 * where the proximity rationale genuinely holds. A pre-filter may only be a superset
 * of what the pure classifier will accept.
 *
 * Binds, in order: `profile_id`, the evening clock threshold, the morning one.
 */
export const ACTIVITY_MIDNIGHT_CANDIDATE_SQL = `
  SELECT e.date AS evening_date, l.date AS morning_date
    FROM activities e
    JOIN activities l
      ON l.profile_id = e.profile_id
     AND l.date = date(e.date, '+1 day')
     AND COALESCE(l.source, 'manual') <> COALESCE(e.source, 'manual')
   WHERE e.profile_id = ?
     AND ${CLOCK_OF("e.start_time")} >= ?
     AND ${CLOCK_OF("l.start_time")} <= ?`;

/** The two thresholds the statement above binds, in its parameter order. */
export const ACTIVITY_MIDNIGHT_CANDIDATE_CLOCKS = [
  EVENING_CANDIDATE_CLOCK,
  MORNING_CANDIDATE_CLOCK,
] as const;
