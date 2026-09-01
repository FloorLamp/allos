// HAS THIS PROFILE EVER CORRECTED A TIME? (#2874)
//
// The retirement gate behind the correction hint (`correctionHintLine`,
// lib/notifications/correction-rows.ts). ONE predicate for every chip surface, and
// deliberately CROSS-DOMAIN: the thing the hint teaches is a single behaviour, so a
// profile that learned it on a dose knows it on food and must not be told again.
//
// NO NEW STORED STATE. Food/dose carry both instants; practice's date + start time is
// composed through its profile zone, all over rows the correction feature already reads,
// rather than a `notify_*` send marker owing a cadence, a retention rule and a sweep for
// a fact the ledger answers directly.
//
// BOTH TABLES SPELL IT `recorded_at` (tap) AND `occurred_at` (stored) — today. They did
// not always: migration 20260814-intake-log-time-vocabulary renamed the dose ledger's
// `taken_at`/`given_at` onto the food ledger's names. `getRecentFoodTaps` and
// `getRecentDoseTaps` are the authority, and these probes read the columns those two do.

import { hoistedStatement } from "../db";
import { CORRECTED_MARK_MS } from "../correction-time";
import { eventInstant, recordInstant } from "../row-instants";
import { getTimezone } from "../settings";

// THE TOLERANCE IS THE MARKER'S, NEVER A SECOND LITERAL: `CORRECTED_MARK_MS` decides
// whether a burst's row says "(corrected)", so reusing it keeps the hint and that marker
// from meaning different things by "corrected".
//
// Seconds, because the comparison happens in SQL: stored instants are second resolution
// (lib/date.ts `utcInstant`), so `strftime('%s', …)` is exact where julianday arithmetic
// would land within floating-point noise of the boundary this gate is tested on.
const CORRECTED_MARK_S = CORRECTED_MARK_MS / 1000;

// STRICTLY GREATER, the ruling's wording: a difference at or under the tolerance is clock
// jitter between two stamps of one request, not a correction. THE MARKER'S OWN TEST IS
// `>=`, so the two part company on EXACTLY 60.000 s and nowhere else — said out loud
// because it is the kind of asymmetry a later reader would "fix" in whichever direction
// they met first. The chat's own writers cannot reach that second (chip steps are 30 and
// 60 minutes, the picker writes whole hours); the stated-instant paths in
// lib/food-log-write.ts were not audited to that grain. Settle it in ONE place if it ever
// needs settling: this line and correction-time's marker.
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

// TWO SHAPES, ONE QUESTION. A practice row's stated anchor is its start — except a
// Telegram just-finished acknowledgement, whose tap stated its END and whose chips move
// that end (`getRecentPracticeTaps`). The `edited` mark answers the first shape only:
// on the second it is the correction burst's own exclusion test, so a chip must leave
// it alone (`restampPracticeLogsCore` says why) and this probe cannot lean on it. For
// that shape the END having moved off the tap IS the correction, which is what the
// comparison below measures — so a chat correction still retires the hint.
const PRACTICE_CORRECTION_STMT = hoistedStatement(
  `SELECT date, start_time, end_time, logged_via, edited, created_at
     FROM practice_logs
    WHERE profile_id = ?
      AND (start_time IS NOT NULL OR end_time IS NOT NULL)`
);

export function hasCorrectedFoodTime(profileId: number): boolean {
  return FOOD_CORRECTION_STMT.get(profileId, CORRECTED_MARK_S) !== undefined;
}

export function hasCorrectedDoseTime(profileId: number): boolean {
  return DOSE_CORRECTION_STMT.get(profileId, CORRECTED_MARK_S) !== undefined;
}

export function hasCorrectedPracticeTime(profileId: number): boolean {
  const tz = getTimezone(profileId);
  const rows = PRACTICE_CORRECTION_STMT.all(profileId) as Array<{
    date: string;
    start_time: string | null;
    end_time: string | null;
    logged_via: string | null;
    edited: number | null;
    created_at: string;
  }>;
  return rows.some((row) => {
    const chatFinished =
      row.end_time != null &&
      (row.logged_via === "telegram-nudge" ||
        row.logged_via === "telegram-command");
    if (!chatFinished && (row.edited !== 1 || row.start_time == null))
      return false;
    const tap = recordInstant("practice_logs", row);
    const stated = eventInstant(
      "practice_logs",
      chatFinished ? { ...row, start_time: row.end_time } : row,
      tz
    );
    if (!tap.known || !stated.known) return false;
    return (
      Math.abs(Date.parse(stated.at) - Date.parse(tap.at)) > CORRECTED_MARK_MS
    );
  });
}

// The gate itself: one OR, so no surface can ask a per-domain version of this question.
// Food first because it is a single-table probe where the dose one joins twice.
export function hasCorrectedAnyTime(profileId: number): boolean {
  return (
    hasCorrectedFoodTime(profileId) ||
    hasCorrectedDoseTime(profileId) ||
    hasCorrectedPracticeTime(profileId)
  );
}
