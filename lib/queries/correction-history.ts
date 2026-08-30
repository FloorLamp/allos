// HAS THIS PROFILE EVER CORRECTED A TIME? (#2874)
//
// The retirement gate behind the correction hint (`correctionHintLine`,
// lib/notifications/correction-rows.ts). ONE predicate for every chip surface, and
// deliberately CROSS-DOMAIN: the thing the hint teaches is a single behaviour, so a
// profile that learned it on a dose knows it on food and must not be told again.
//
// NO NEW STORED STATE. Both ledgers already carry the two instants a correction moves
// apart, and the restamp write cores are the only things that move them — so this is two
// LIMIT 1 probes over rows the correction feature already reads, rather than a
// `notify_*` send marker that would owe a cadence, a retention rule and a sweep for a
// fact the ledger answers directly.
//
// THE COLUMN ROLES, because the same name means different things one table over:
//
//   | domain | tap instant   | stored instant | table              |
//   | food   | recorded_at   | occurred_at    | food_log_events    |
//   | dose   | recorded_at   | occurred_at    | intake_item_logs   |
//
// They agree TODAY and did not always: migration 20260814-intake-log-time-vocabulary
// renamed the dose ledger's `taken_at`/`given_at` pair onto the food ledger's spelling.
// `getRecentFoodTaps` and `getRecentDoseTaps` are the authority for this mapping — both
// normalise to `tapAt`/`statedAt` — and these probes ask their question of the same two
// columns those two read.

import { hoistedStatement } from "../db";
import { CORRECTED_MARK_MS } from "../correction-time";

// THE TOLERANCE IS THE MARKER'S, NEVER A SECOND LITERAL. `CORRECTED_MARK_MS` is what
// decides whether a burst's row says "(corrected)", so reusing it is what keeps the hint
// and that marker from disagreeing about what counts as a correction — a second constant
// here could retire the hint for a profile whose rows never claimed to be corrected, or
// keep teaching one whose rows do.
//
// Seconds, because the comparison happens in SQL: every stored instant is second
// resolution (lib/date.ts `utcInstant`), so `strftime('%s', …)` is exact where julianday
// arithmetic would land within floating-point noise of the boundary this gate is tested
// on.
const CORRECTED_MARK_S = CORRECTED_MARK_MS / 1000;

// STRICTLY GREATER. The rule is "differ by MORE than the tolerance": a difference at or
// under it is clock jitter between two stamps of one request, not a correction.
//
// THE MARKER'S OWN TEST IS `>=`, and the two therefore part company on EXACTLY 60.000 s
// and nowhere else — a row a hair over an even minute from its tap would say
// "(corrected)" while the hint still taught. Said out loud because it is the kind of
// asymmetry a later reader would "fix" in whichever direction they met first: the
// constant is shared deliberately and the comparison is the ruling's wording. The chat's
// own writers cannot reach the disputed second — CORRECTION_CHIP_MINUTES steps are 30 and
// 60 minutes and the picker writes whole hours — and the app's sheets edit day + hour;
// the STATED-instant paths in lib/food-log-write.ts were not audited to that grain. If it
// ever needs settling, settle it in ONE place: this line and correction-time's marker.
const FOOD_CORRECTION_STMT = hoistedStatement(
  `SELECT 1 AS found
     FROM food_log_events
    WHERE profile_id = ?
      AND occurred_at IS NOT NULL
      AND ABS(CAST(strftime('%s', occurred_at) AS INTEGER)
            - CAST(strftime('%s', recorded_at) AS INTEGER)) > ?
    LIMIT 1`
);

// Profile-scoped through the dose → item JOIN, and inheriting `getRecentDoseTaps`'s own
// conditions (`status = 'taken'`, a non-null stored instant) so the probe cannot answer
// yes about a row that surface would never have offered a correction on.
const DOSE_CORRECTION_STMT = hoistedStatement(
  `SELECT 1 AS found
     FROM intake_item_logs l
     JOIN intake_item_doses d ON d.id = l.dose_id
     JOIN intake_items s ON s.id = d.item_id
    WHERE s.profile_id = ?
      AND l.status = 'taken'
      AND l.occurred_at IS NOT NULL
      AND ABS(CAST(strftime('%s', l.occurred_at) AS INTEGER)
            - CAST(strftime('%s', l.recorded_at) AS INTEGER)) > ?
    LIMIT 1`
);

export function hasCorrectedFoodTime(profileId: number): boolean {
  return FOOD_CORRECTION_STMT.get(profileId, CORRECTED_MARK_S) !== undefined;
}

export function hasCorrectedDoseTime(profileId: number): boolean {
  return DOSE_CORRECTION_STMT.get(profileId, CORRECTED_MARK_S) !== undefined;
}

// The gate itself: one OR, so no surface can ask a per-domain version of this question.
// Food first because it is a single-table probe where the dose one joins twice.
export function hasCorrectedAnyTime(profileId: number): boolean {
  return hasCorrectedFoodTime(profileId) || hasCorrectedDoseTime(profileId);
}
