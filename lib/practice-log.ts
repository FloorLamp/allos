// The DB seam for WELLNESS PRACTICE session logging (issue #1259): the one-tap write
// core plus the day/week reads over the dedicated `practice_logs` store. AUTH-BLIND and
// profileId-FIRST (the write-core convention) — no lib/auth import; the calling Server
// Action owns the auth gate. Every statement filters profile_id (practice_logs is a
// profile-owned table, enforced by the profile-scoping test). The pure range/pace
// decisions live in lib/practice.ts.

import { db, today } from "./db";
import { writeTx } from "./db";
import { daysBetweenDateStr, isRealIsoDate } from "./date";
import {
  normalizePracticeName,
  practiceIdentity,
  samePractice,
} from "./practice";
import type {
  PracticeLog,
  PracticeLogOutcome,
  PracticeSessionMutationOutcome,
} from "./types";

// A far-off (forged) date can't land a misdated session row (the #614 dose-log posture);
// a legitimate late correction within the window still logs to its own day.
export const PRACTICE_LOG_DATE_WINDOW_DAYS = 30;

function isPracticeDateAccepted(profileId: number, date: string): boolean {
  if (!isRealIsoDate(date)) return false;
  const diff = daysBetweenDateStr(today(profileId), date);
  return diff != null && Math.abs(diff) <= PRACTICE_LOG_DATE_WINDOW_DAYS;
}

// SQL cannot call practiceIdentity(), so resolve its finite preimage from the
// profile's stored target/log spellings once, then bind that exact set into reads.
// This catches legacy "Sauna" / " sauna " / "SAUNA" variants without interpolating
// user text and keeps every underlying statement profile-scoped.
export function getPracticeSpellings(
  profileId: number,
  practice: string
): string[] {
  const identity = practiceIdentity(practice);
  if (!identity) return [];
  const values = new Set<string>([normalizePracticeName(practice)]);
  for (const row of db
    .prepare(
      `SELECT DISTINCT practice AS value FROM practice_logs
        WHERE profile_id = ?
       UNION
       SELECT DISTINCT scope_value AS value FROM frequency_targets
        WHERE profile_id = ? AND scope_kind = 'practice'`
    )
    .all(profileId, profileId) as { value: string }[]) {
    if (practiceIdentity(row.value) === identity) values.add(row.value);
  }
  return [...values].filter(Boolean);
}

function inClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

// Distinct sessions logged for a (practice, date). The day's RUNNING COUNT, reported by
// the outcome so a surface can say "logged — 2nd session today" (the PRN widget shape).
export function getPracticeDayCount(
  profileId: number,
  practice: string,
  date: string
): number {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(spellings)}) AND date = ?`
    )
    .get(profileId, ...spellings, date) as { n: number };
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
  limit = 50,
  window?: { start: string; end: string }
): PracticeLog[] {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return [];
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  const windowSql = window ? "AND date >= ? AND date <= ?" : "";
  const args: Array<string | number> = [profileId, ...spellings];
  if (window) args.push(window.start, window.end);
  args.push(boundedLimit);
  return db
    .prepare(
      `SELECT id, practice, date, time, duration_min, notes, created_at
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(spellings)})
          ${windowSql}
        ORDER BY date DESC, COALESCE(time, '99:99') DESC, id DESC
        LIMIT ?`
    )
    .all(...args) as PracticeLog[];
}

export function getPracticeUsageInWindow(
  profileId: number,
  practice: string,
  start: string,
  end: string
): { sessions: number; lastUsed: string | null } {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return { sessions: 0, lastUsed: null };
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions, MAX(date) AS lastUsed
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(spellings)})
          AND date >= ? AND date <= ?`
    )
    .get(profileId, ...spellings, start, end) as {
    sessions: number;
    lastUsed: string | null;
  };
  return row;
}

export function getPracticeDayUsageInWindow(
  profileId: number,
  practice: string,
  start: string,
  end: string
): { date: string; count: number }[] {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return [];
  return db
    .prepare(
      `SELECT date, COUNT(*) AS count
         FROM practice_logs
        WHERE profile_id = ? AND practice IN (${inClause(spellings)})
          AND date >= ? AND date <= ?
        GROUP BY date
        ORDER BY date ASC`
    )
    .all(profileId, ...spellings, start, end) as {
    date: string;
    count: number;
  }[];
}

export function getPracticeSession(
  profileId: number,
  id: number
): PracticeLog | null {
  return (
    (db
      .prepare(
        `SELECT id, practice, date, time, duration_min, notes, created_at
           FROM practice_logs WHERE id = ? AND profile_id = ?`
      )
      .get(id, profileId) as PracticeLog | undefined) ?? null
  );
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
  if (!isPracticeDateAccepted(profileId, input.date))
    return { kind: "invalid-date" };
  const current = getPracticeSession(profileId, id);
  if (!current) return { kind: "not-found" };
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
        SET date = ?, time = ?, duration_min = ?, notes = ?
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
export function deletePracticeSession(
  profileId: number,
  id: number
): PracticeSessionMutationOutcome {
  const info = db
    .prepare("DELETE FROM practice_logs WHERE id = ? AND profile_id = ?")
    .run(id, profileId);
  return info.changes === 1 ? { kind: "deleted", id } : { kind: "not-found" };
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
      `UPDATE practice_logs SET practice = ?
        WHERE profile_id = ? AND practice IN (${inClause(spellings)})`
    )
    .run(next, profileId, ...spellings);
  return info.changes;
}

// Small exported predicate used by target-store reconciliation without importing
// SQL details. Kept here beside the finite-preimage resolver.
export function practiceNameMatches(a: string, b: string): boolean {
  return samePractice(a, b);
}
