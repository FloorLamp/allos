// Part of the lib/queries/intake barrel. The dose-schedule LIFECYCLE core (#2131):
// retiring a removed dose, restoring (un-retiring) one, and the effective-dated
// schedule-version bookkeeping both transitions share with the dose edit path.
//
// CLAUDE.md states the retire rule as doctrine — "a removed dose with logs is retired
// rather than deleted" (hard-deleting would ON DELETE CASCADE away its taken history) —
// and this module is where that rule is EXECUTED. intake_item_doses is registered in
// STATEFUL_WRITE_TABLES with this module as the only core for its `retired` column, so
// the raw retire statements that used to live in the Server Action are now a scan
// failure anywhere else. Both transitions return typed outcomes (#232); un-retire is
// the reopen every sibling lifecycle already has (equipment restore, provider
// un-archive, episode reopen) — without it, a mis-tap's only "fix" was minting a new
// dose id, which detaches exactly the adherence history, Telegram keyboards and dedupe
// keys that retire-not-delete exists to preserve (#2000).
//
// DUENESS IS EFFECTIVE-DATED, NEVER RETROACTIVE (#1973): retiring appends a schedule
// version that CLOSES the dose's window as of the retire day, and un-retiring appends a
// fresh version effective the restore day — so the days in between never read as
// "missed" after a restore, and no earlier version is rewritten. Editing a dose still
// never rewrites adherence history; these transitions only bound WHICH days are due.

import { db, today, writeTx, type Tx } from "../../db";
import { casUpdate, readForUpdate } from "../../tx";
import { sqlNow } from "../../clock";
import { shiftDateStr } from "../../date";
import type { DoseSchedule } from "../../intake-cadence";
import { invalidateDoseScheduleVersions } from "./schedule";
import type { FoodTiming } from "../../types";

// Record ONE version of a dose's schedule, effective from a profile-local calendar day
// (#1973, migration 151). UPSERT on (dose_id, effective_from): several schedule edits on
// one day collapse to that day's final state, which is the right grain because dueness is
// evaluated per DAY. Append-only in every other respect — an earlier version is never
// rewritten, which is what makes a past day judgeable by the rule that applied then.
//
// `created_at` comes from the CLOCK SEAM (sqlNow, #1534) and is deliberately NOT the same
// value as `effective_from`: a backfilled version records a past effective day while
// having been written now.
//
// Moved here from the nutrition Server Action module (#2131) so the retire/un-retire
// transitions and the dose-edit path share ONE version writer.
const insertScheduleVersionStmt = () =>
  db.prepare(
    `INSERT INTO intake_dose_schedule_versions
       (dose_id, effective_from, time_of_day, weekdays, start_date, end_date, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(dose_id, effective_from) DO UPDATE SET
       time_of_day = excluded.time_of_day,
       weekdays    = excluded.weekdays,
       start_date  = excluded.start_date,
       end_date    = excluded.end_date,
       created_at  = excluded.created_at`
  );

export function recordScheduleVersion(
  doseId: number,
  effectiveFrom: string,
  schedule: DoseSchedule
): void {
  insertScheduleVersionStmt().run(
    doseId,
    effectiveFrom,
    schedule.time_of_day ?? null,
    schedule.weekdays ?? null,
    schedule.start_date ?? null,
    schedule.end_date ?? null,
    sqlNow()
  );
  // The current-schedule readers memoize this profile's history for a few seconds
  // (#2066). This is the write whose result is rendered right afterwards — the edited
  // page, the rebuilt reminder — so it drops the memo rather than waiting out the TTL.
  // Cheap and rare: recording a version happens on a dose edit, not on a read.
  invalidateDoseScheduleVersions();
}

// The closing version a retire appends: the dose's own rule with its window ended the
// day BEFORE the transition day (both bounds inclusive, so the retire day itself is no
// longer due). An already-tighter end_date is kept — closing a window can only narrow.
function closedWindow(
  schedule: Pick<
    DoseSchedule,
    "time_of_day" | "weekdays" | "start_date" | "end_date"
  >,
  transitionDay: string
): DoseSchedule {
  const dayBefore = shiftDateStr(transitionDay, -1);
  const end =
    schedule.end_date != null && schedule.end_date < dayBefore
      ? schedule.end_date
      : dayBefore;
  return {
    time_of_day: schedule.time_of_day ?? null,
    weekdays: schedule.weekdays ?? null,
    start_date: schedule.start_date ?? null,
    end_date: end,
  };
}

interface DoseScheduleRow {
  id: number;
  time_of_day: string | null;
  weekdays: string | null;
  start_date: string | null;
  end_date: string | null;
}

// Apply the retire-or-delete rule to every live dose the edit form REMOVED (#2131,
// formerly two raw statements in updateIntakeItem). Runs inside the caller's
// transaction — the Tx token is the proof, since the kept-set was computed under the
// same write lock. A removed dose with adherence logs is RETIRED (kept, flagged, its
// dueness window closed as of `todayStr`); one no log ever pointed at is hard-deleted.
// Already-retired rows are never resubmitted by the form (it only sees live doses), so
// both statements skip them and history stays untouched. Returns the accounting.
export function retireRemovedDoses(
  tx: Tx,
  profileId: number,
  itemId: number,
  keptIds: number[],
  todayStr: string
): { retired: number; deleted: number } {
  // ids are positive, so a sentinel keeps the NOT IN well-formed for an empty kept set.
  const kept = keptIds.length ? keptIds : [-1];
  const placeholders = kept.map(() => "?").join(",");
  const toRetire = db
    .prepare(
      `SELECT d.id, d.time_of_day, d.weekdays, d.start_date, d.end_date
         FROM intake_item_doses d
         JOIN intake_items s ON s.id = d.item_id
        WHERE d.item_id = ? AND s.profile_id = ? AND d.retired = 0
          AND d.id NOT IN (${placeholders})
          AND EXISTS (SELECT 1 FROM intake_item_logs l
                       WHERE l.dose_id = d.id)`
    )
    .all(itemId, profileId, ...kept) as DoseScheduleRow[];
  for (const d of toRetire) {
    casUpdate(
      tx,
      db.prepare(
        `UPDATE intake_item_doses SET retired = 1
          WHERE id = ? AND item_id = ? AND retired = 0
            AND EXISTS (
              SELECT 1 FROM intake_items s
               WHERE s.id = intake_item_doses.item_id AND s.profile_id = ?
            )`
      ),
      d.id,
      itemId,
      profileId
    );
    // Close the dueness window as of the retire day (#1973 append-only): without this,
    // a later restore would re-judge the retired gap by the pre-retire rule and invent
    // misses retroactively.
    recordScheduleVersion(d.id, todayStr, closedWindow(d, todayStr));
  }
  const deleted = db
    .prepare(
      `DELETE FROM intake_item_doses
        WHERE item_id = ? AND retired = 0 AND id NOT IN (${placeholders})
          AND EXISTS (
            SELECT 1 FROM intake_items s
             WHERE s.id = intake_item_doses.item_id AND s.profile_id = ?
          )`
    )
    .run(itemId, ...kept, profileId);
  return { retired: toRetire.length, deleted: deleted.changes };
}

// The dose row an un-retire hands back so the caller (the edit form) can show the
// restored row without a refetch. Plain serializable fields, never the sqlite proxy.
export interface RestoredDose {
  id: number;
  item_id: number;
  amount: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
  weekdays: string | null;
  start_date: string | null;
  end_date: string | null;
}

export type UnretireDoseOutcome =
  | { kind: "restored"; dose: RestoredDose }
  | { kind: "not-found" }
  | { kind: "not-retired" }
  | { kind: "schedule-conflict" };

// Restore a retired dose to the schedule (#2131) — the reopen transition the retire
// never had. GUARDED: only a retired dose with no live dose in the same time-of-day
// slot reopens (`schedule-conflict` otherwise — restoring it would put two identical
// slots on the schedule and every keyed surface would be ambiguous). Dueness resumes
// from the restore day via an appended schedule version, never retroactively; the
// dose's id — and with it the adherence history, Telegram keyboards and dedupe keys
// #2000 keeps stable — is exactly the one that was retired.
export function unretireDose(
  profileId: number,
  doseId: number
): UnretireDoseOutcome {
  return writeTx((tx): UnretireDoseOutcome => {
    const row = readForUpdate<RestoredDose & { retired: number }>(
      tx,
      db.prepare(
        `SELECT d.id, d.item_id, d.amount, d.time_of_day, d.food_timing,
                d.weekdays, d.start_date, d.end_date, d.retired
           FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND s.profile_id = ?`
      ),
      doseId,
      profileId
    );
    if (!row) return { kind: "not-found" };
    if (!row.retired) return { kind: "not-retired" };
    const conflict = readForUpdate<{ id: number }>(
      tx,
      db.prepare(
        `SELECT d2.id FROM intake_item_doses d2
          WHERE d2.item_id = ? AND d2.retired = 0 AND d2.id <> ?
            AND d2.time_of_day IS ? LIMIT 1`
      ),
      row.item_id,
      doseId,
      row.time_of_day
    );
    if (conflict) return { kind: "schedule-conflict" };
    const res = casUpdate(
      tx,
      db.prepare(
        `UPDATE intake_item_doses SET retired = 0
          WHERE id = ? AND retired = 1
            AND EXISTS (
              SELECT 1 FROM intake_items s
               WHERE s.id = intake_item_doses.item_id AND s.profile_id = ?
            )`
      ),
      doseId,
      profileId
    );
    if (res.kind === "stale") return { kind: "not-retired" };
    const todayStr = today(profileId);
    // LEGACY gap closure: a dose retired before closing-versions shipped has no version
    // ending its window, so the retired gap would resolve to the pre-retire rule and
    // read as missed. Append-only backfill: close the window from the day after its
    // last recorded administration (retire always implied logs existed). Skipped when a
    // closing version is already in force — the new retire path writes one.
    const latest = readForUpdate<{
      effective_from: string;
      end_date: string | null;
    }>(
      tx,
      db.prepare(
        `SELECT v.effective_from, v.end_date
           FROM intake_dose_schedule_versions v
           JOIN intake_item_doses d ON d.id = v.dose_id
           JOIN intake_items s ON s.id = d.item_id
          WHERE v.dose_id = ? AND s.profile_id = ?
          ORDER BY v.effective_from DESC, v.id DESC LIMIT 1`
      ),
      doseId,
      profileId
    );
    const gapClosed =
      latest != null &&
      latest.end_date != null &&
      latest.effective_from <= todayStr &&
      latest.end_date < todayStr;
    if (!gapClosed) {
      const lastLog = readForUpdate<{ d: string | null }>(
        tx,
        db.prepare(
          `SELECT MAX(l.date) AS d FROM intake_item_logs l
             JOIN intake_items s ON s.id = l.item_id
            WHERE l.dose_id = ? AND s.profile_id = ?`
        ),
        doseId,
        profileId
      );
      const from = lastLog?.d ? shiftDateStr(lastLog.d, 1) : null;
      if (from && from < todayStr) {
        recordScheduleVersion(doseId, from, closedWindow(row, from));
      }
    }
    // Dueness resumes TODAY: the dose's own live rule, effective from the restore day.
    // (On a same-day retire→restore this upserts over the closing version, so the day
    // is simply due again.)
    recordScheduleVersion(doseId, todayStr, {
      time_of_day: row.time_of_day,
      weekdays: row.weekdays,
      start_date: row.start_date,
      end_date: row.end_date,
    });
    const { retired: _r, ...dose } = row;
    return { kind: "restored", dose };
  });
}
