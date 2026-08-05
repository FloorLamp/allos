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
import type {
  PracticeLogOutcome,
  PracticeSessionDeleteOutcome,
  PracticeSessionMutationOutcome,
} from "./types";
import { captureDelete } from "./undo-delete-db";
import {
  getPracticeDayCount,
  getPracticeSession,
  getPracticeSpellings,
} from "./queries/wellness";

// A far-off (forged) date can't land a misdated session row (the #614 dose-log posture);
// a legitimate late correction within the window still logs to its own day.
export const PRACTICE_LOG_DATE_WINDOW_DAYS = 30;

function isPracticeDateAccepted(profileId: number, date: string): boolean {
  if (!isRealIsoDate(date)) return false;
  const diff = daysBetweenDateStr(today(profileId), date);
  return diff != null && Math.abs(diff) <= PRACTICE_LOG_DATE_WINDOW_DAYS;
}

// An imported historical session may be far outside the new-log window but still
// needs ordinary correction. Accept a date near that existing row as well as the
// normal today-relative window; this keeps forged edits bounded without making an
// old session impossible to save even when its date is unchanged.
function isPracticeEditDateAccepted(
  profileId: number,
  currentDate: string,
  nextDate: string
): boolean {
  if (!isRealIsoDate(nextDate)) return false;
  if (isPracticeDateAccepted(profileId, nextDate)) return true;
  const diff = daysBetweenDateStr(currentDate, nextDate);
  return diff != null && Math.abs(diff) <= PRACTICE_LOG_DATE_WINDOW_DAYS;
}

function inClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
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

export function updatePracticeSession(
  profileId: number,
  id: number,
  input: {
    date: string;
    time?: string | null;
    durationMin?: number | null;
    notes?: string | null;
  }
): PracticeSessionMutationOutcome {
  const current = getPracticeSession(profileId, id);
  if (!current) return { kind: "not-found" };
  if (!isPracticeEditDateAccepted(profileId, current.date, input.date))
    return { kind: "invalid-date" };
  const time =
    input.time && /^\d{2}:\d{2}$/.test(input.time) ? input.time : null;
  const durationMin =
    input.durationMin != null &&
    Number.isFinite(input.durationMin) &&
    input.durationMin > 0
      ? Math.round(input.durationMin)
      : null;
  const notes = input.notes?.trim() || null;
  db.prepare(
    `UPDATE practice_logs
        SET date = ?, time = ?, duration_min = ?, notes = ?, edited = 1
      WHERE id = ? AND profile_id = ?`
  ).run(input.date, time, durationMin, notes, id, profileId);
  const session = getPracticeSession(profileId, id);
  return session ? { kind: "updated", session } : { kind: "not-found" };
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
//
// UNDOABLE since #2038. Deleting a whole practice has been undoable for as long as the
// wellness-practice kinds have existed, and so has the structurally identical substance
// history row — deleting ONE session was the odd path out, permanent, which read as an
// accident rather than a decision. It now captures through the shared substrate: one
// transaction holds the capture, the delete, and the re-import tombstone that keeps a
// resync from resurrecting an imported session, exactly as the whole-practice kinds do.
// The tombstone is removed again if the user undoes, and outlives the retention window
// if they don't — undo and idempotency are orthogonal and both hold.
export function deletePracticeSession(
  profileId: number,
  id: number
): PracticeSessionDeleteOutcome {
  return writeTx(() => {
    const undoId = captureDelete("practice-session", profileId, id);
    return undoId == null
      ? { kind: "not-found" as const }
      : { kind: "deleted" as const, id, undoId };
  });
}

// Re-key every stored spelling in one identity family after a practice rename.
// The target id is stable; the event rows follow the display name so history never
// becomes orphaned. Returns the number of log rows changed.
export function renamePracticeSessions(
  profileId: number,
  from: string,
  to: string
): number {
  const next = normalizePracticeName(to);
  if (!next) return 0;
  const spellings = getPracticeSpellings(profileId, from);
  if (spellings.length === 0) return 0;
  const info = db
    .prepare(
      `UPDATE practice_logs
          SET practice = ?,
              edited = CASE
                WHEN external_id IS NOT NULL AND practice <> ? THEN 1
                ELSE edited
              END
        WHERE profile_id = ? AND practice IN (${inClause(spellings)})`
    )
    .run(next, next, profileId, ...spellings);
  return info.changes;
}
