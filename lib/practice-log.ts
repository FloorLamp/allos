// The DB seam for WELLNESS PRACTICE session logging (issue #1259): the one-tap write
// core plus the day/week reads over the dedicated `practice_logs` store. AUTH-BLIND and
// profileId-FIRST (the write-core convention) — no lib/auth import; the calling Server
// Action owns the auth gate. Every statement filters profile_id (practice_logs is a
// profile-owned table, enforced by the profile-scoping test). The pure range/pace
// decisions live in lib/practice.ts.

import { db, today } from "./db";
import { writeTx } from "./db";
import { daysBetweenDateStr, isRealIsoDate } from "./date";
import { normalizePracticeName } from "./practice";
import type { PracticeLog, PracticeLogOutcome } from "./types";

// A far-off (forged) date can't land a misdated session row (the #614 dose-log posture);
// a legitimate late correction within the window still logs to its own day.
const PRACTICE_LOG_DATE_WINDOW_DAYS = 30;

function isPracticeDateAccepted(profileId: number, date: string): boolean {
  if (!isRealIsoDate(date)) return false;
  const diff = daysBetweenDateStr(today(profileId), date);
  return diff != null && Math.abs(diff) <= PRACTICE_LOG_DATE_WINDOW_DAYS;
}

// Distinct sessions logged for a (practice, date). The day's RUNNING COUNT, reported by
// the outcome so a surface can say "logged — 2nd session today" (the PRN widget shape).
export function getPracticeDayCount(
  profileId: number,
  practice: string,
  date: string
): number {
  const name = normalizePracticeName(practice);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM practice_logs
        WHERE profile_id = ? AND practice = ? AND date = ?`
    )
    .get(profileId, name, date) as { n: number };
  return row.n;
}

// One-tap log a practice session. NOT idempotent — multi-session days are the point
// (#797 ledger model), so each accepted call appends a NEW row and returns the day's
// running count. `time`/`duration_min`/`notes` are optional (the one-tap paths pass
// none; the expanded form / Telegram tap supply time). Returns a typed outcome — the
// caller answers from it, never unconditionally confirms.
export function logPracticeSession(
  profileId: number,
  practice: string,
  date: string,
  opts: {
    time?: string | null;
    durationMin?: number | null;
    notes?: string | null;
  } = {}
): PracticeLogOutcome {
  const name = normalizePracticeName(practice);
  if (!name || !isPracticeDateAccepted(profileId, date)) {
    return { kind: "invalid-date" };
  }
  const time = opts.time && /^\d{2}:\d{2}$/.test(opts.time) ? opts.time : null;
  const durationMin =
    opts.durationMin != null &&
    Number.isFinite(opts.durationMin) &&
    opts.durationMin > 0
      ? Math.round(opts.durationMin)
      : null;
  const notes = opts.notes?.trim() || null;

  return writeTx((): PracticeLogOutcome => {
    db.prepare(
      `INSERT INTO practice_logs
         (profile_id, practice, date, time, duration_min, notes)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(profileId, name, date, time, durationMin, notes);
    const count = getPracticeDayCount(profileId, name, date);
    return { kind: "logged", count, date };
  });
}

// The profile's logged sessions for a practice, newest first. Used by the detail /
// session-history surfaces (and tests). Bounded by the caller.
export function getPracticeSessions(
  profileId: number,
  practice: string,
  limit = 50
): PracticeLog[] {
  const name = normalizePracticeName(practice);
  return db
    .prepare(
      `SELECT id, practice, date, time, duration_min, notes, created_at
         FROM practice_logs
        WHERE profile_id = ? AND practice = ?
        ORDER BY date DESC, COALESCE(time, '99:99') DESC, id DESC
        LIMIT ?`
    )
    .all(profileId, name, limit) as PracticeLog[];
}

// Log a session against a practice frequency TARGET id (the Telegram Done button path,
// #1259): resolve the target's practice NAME under profile scope, then log for TODAY.
// A deleted / cross-profile / non-practice target answers `stale-target` (the frozen-
// snapshot contract — the message may be stale) — nothing is written. The `date` is the
// profile-local today (the tap's day; Telegram stamps its own time-of-day for free).
export function logPracticeByTargetId(
  profileId: number,
  targetId: number
): PracticeLogOutcome {
  const row = db
    .prepare(
      `SELECT scope_value FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    )
    .get(targetId, profileId) as { scope_value: string } | undefined;
  if (!row) return { kind: "stale-target" };
  return logPracticeSession(profileId, row.scope_value, today(profileId));
}

// Delete one logged session by id (a correction). Profile-scoped so a leaked id no-ops.
export function deletePracticeSession(profileId: number, id: number): void {
  db.prepare("DELETE FROM practice_logs WHERE id = ? AND profile_id = ?").run(
    id,
    profileId
  );
}
