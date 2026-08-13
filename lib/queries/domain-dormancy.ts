// The one DB read domain dormancy (#2652, lib/domain-dormancy.ts) needs that no
// surface already computes.
//
// Every other dormancy-eligible domain answers "when did this last arrive?" out of a
// read its own card ALREADY issues — the weight series before its 90-day window is
// applied, the vitals model's two dated rows, the current-per-marker observation set
// behind Recent labs. Those stay where they are, so the card and the dormancy verdict
// are the same computation and cannot disagree (#221).
//
// Sleep is the exception, and not because its read is unavailable — because it answers
// a different question. `getLastNightSummary` ELECTS one origin per profile (so two
// devices cannot double-count a night), over a row-capped session read and a 180-day
// duration trend, and reports the most recent night AS THAT ORIGIN SAW IT. Dormancy
// asks the weaker, source-blind question — did anything arrive at all. On a profile
// with a `strict` source pin the two answers genuinely diverge: the pinned wearable can
// be months silent while a phone keeps reporting nightly, and the domain is plainly not
// dormant. `lib/__db_tests__/domain-dormancy.test.ts` fixes that case in place.

import { hoistedStatement } from "../db";

// Hoisted (lib/db.ts): the dashboard reaches this once per render, and a cross-profile
// surface would reach it once per profile — the exact shape the hoisting rule names.
const lastSleepStmt = hoistedStatement(
  `SELECT MAX(date) AS date FROM metric_samples
    WHERE profile_id = ? AND metric = 'sleep_min'`
);

/** The newest recorded sleep day for a profile, or null when none was ever recorded. */
export function getLastSleepRecordDate(profileId: number): string | null {
  const row = lastSleepStmt.get(profileId) as
    { date: string | null } | undefined;
  return row?.date ?? null;
}
