// THE DAY LEDGER'S DOSE HALF (#3987 phase 1).
//
// One read for "which doses did this profile RESOLVE on this day, and what does each
// row say?" — taken and skipped alike, because a skip is a recorded event and the
// ledger states it with its stored reason rather than hiding it.
//
// WHY A NEW READER RATHER THAN AN EXISTING ONE. `getIntakeDoseLedgerPage` and
// `getIntakeDoseHistory*` are TAKEN-only and window-shaped (they serve the record and
// the per-item history panel); the adherence readers answer with dose ids and no row
// detail. None of them can say what a skipped row's reason was, and none is scoped to a
// single day. This is that question, asked once.
//
// SUPPLEMENTS ONLY. Medications keep their own page (the umbrella ruling), exactly as
// the schedule this ledger replaces did (`isMed` there).
//
// Profile-scoped in SQL through the parent item, which is where `intake_item_logs`
// carries ownership.

import { db } from "../db";
import { zonedDateParts } from "../date";
import { getTimezone } from "../settings";
import { bestKnownInstant } from "../row-instants";
import { detailSegment } from "../history-format";
import { doseBucketOn } from "../intake-schedule";
import type { LedgerDose } from "../day-ledger";
import { getIntakeDoses, getRetiredDoses } from "./intake/schedule";

type DayDoseLogRow = {
  id: number;
  dose_id: number;
  item_id: number;
  status: string;
  skip_reason: string | null;
  occurred_at: string | null;
  recorded_at: string;
  amount: string | null;
  product: string | null;
  item_name: string;
  stack: string | null;
};

/**
 * Every supplement dose this profile resolved on `date`, as ledger rows.
 *
 * The bucket is `doseBucketOn` — the schedule version in force THAT DAY (#1973), not
 * the current row — so a dose moved evening-to-morning last week still files under the
 * slot it occupied when it was taken. That is the same resolver `pendingDayDoses` uses
 * for the still-due half, which is what lets the two halves share one group system.
 *
 * Read in TAP order (`recorded_at`, then id) — deterministic, and deliberately not the
 * order it renders in: `buildDayLedger` owns that, and asking this query to guess it
 * would be a second opinion about the same question.
 */
export function getDayDoseLedger(
  profileId: number,
  date: string
): LedgerDose[] {
  const rows = db
    .prepare(
      `SELECT l.id, l.dose_id, l.item_id, l.status, l.skip_reason,
              l.occurred_at, l.recorded_at, l.amount, l.product,
              s.name AS item_name, s.stack
         FROM intake_item_logs l
         JOIN intake_items s ON s.id = l.item_id
        WHERE s.profile_id = ? AND l.date = ? AND s.kind != 'medication'
        ORDER BY l.recorded_at, l.id`
    )
    .all(profileId, date) as DayDoseLogRow[];
  if (rows.length === 0) return [];
  const schedules = new Map(
    [...getIntakeDoses(profileId), ...getRetiredDoses(profileId)].map((d) => [
      d.id,
      d,
    ])
  );
  const tz = getTimezone(profileId);
  const out: LedgerDose[] = [];
  for (const row of rows) {
    if (row.status !== "taken" && row.status !== "skipped") continue;
    const schedule = schedules.get(row.dose_id);
    // The row-level time question asked once (#2205): the stated instant when somebody
    // named one, else the record chain — with the answer saying WHICH it was, so an
    // unstated row renders through #3958's "logged 8:06pm" grammar instead of a bare
    // clock claiming an administration time the row does not state.
    const when = bestKnownInstant("intake_item_logs", row);
    // `recorded_at` is NOT NULL, so the chain always answers; a row that somehow has no
    // instant at all has no honest place on a timed ledger and is left off rather than
    // filed under a minute nothing states.
    if (!when.known) continue;
    const instant = new Date(when.at);
    out.push({
      kind: "dose",
      id: `dose:${row.id}`,
      logId: row.id,
      doseId: row.dose_id,
      itemId: row.item_id,
      name: row.item_name,
      detail: detailSegment([row.amount, row.product]),
      stack: row.stack,
      status: row.status,
      skipReason: row.skip_reason,
      bucket: schedule ? doseBucketOn(schedule, date) : "Anytime",
      hhmm: zonedDateParts(tz, instant).hhmm,
      clockKind: when.semantic === "event" ? "stated" : "logged",
      // The composed tap's identity is the minute it wrote in — `recorded_at` is the
      // immutable tap, never the stated instant a later correction can move.
      writeMinute: row.recorded_at.slice(0, 16),
    });
  }
  return out;
}
