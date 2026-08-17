// The DB seam for WELLNESS PRACTICE session logging (issue #1259): the one-tap write
// core plus the day/week reads over the dedicated `practice_logs` store. AUTH-BLIND and
// profileId-FIRST (the write-core convention) — no lib/auth import; the calling Server
// Action owns the auth gate. Every statement filters profile_id (practice_logs is a
// profile-owned table, enforced by the profile-scoping test). The pure range/pace
// decisions live in lib/practice.ts.

import { db, nowTime, today } from "./db";
import { writeTx } from "./db";
import { daysBetweenDateStr, isRealIsoDate, zonedDateParts } from "./date";
import { sqlNow } from "./clock";
import { burstFrom, type TapEvent } from "./correction-time";
import { eventInstant, recordInstant } from "./row-instants";
import { getTimezone } from "./settings";
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

// The profile-local HH:MM a TAP happened at, or null when the row being written is
// not about today (see logPracticeSession's `time` contract). Reads the clock seam
// through `zonedMinuteStr`, so a frozen e2e instant stamps the frozen minute.
function tapInstant(profileId: number, date: string): string | null {
  return date === today(profileId) ? nowTime(profileId) : null;
}

// One-tap log a practice session. NOT idempotent — multi-session days are the point
// (#797 ledger model), so each accepted call appends a NEW row and returns the day's
// running count. `duration_min`/`notes` are optional. Returns a typed outcome — the
// caller answers from it, never unconditionally confirms.
//
// ---- `time`, and why the one-tap paths now carry one (#2204 part 2) -------------
//
// `time` is deliberately THREE-valued, and the three values are three different
// statements a caller can make:
//
//   • a "HH:MM" string — this session happened THEN. The expanded form's time input.
//   • `null`          — this session has NO instant, and that is a decision. The
//                       expanded form posts this when its time input is left empty,
//                       including on a backdated correction where "now" would be a lie.
//   • omitted         — the caller is a TAP and has no opinion. The write core stamps
//                       the profile-local instant of the tap, which is the truth it
//                       actually has.
//
// The omitted case is new. Until #2202 nothing read `practice_logs.time`, so
// `lib/quick-log.ts` correctly declared the practice entry `day-only`: an instant with
// no consumer is precision that a later reader invents a meaning for. `lib/weekly-rhythm.ts`
// is now that consumer — `modalHour()` picks each practice's typical session hour and
// the retimed pace nudge fires at it — which inverted the old omission into a real
// defect: every quick-sheet tap and every Telegram "Done ✅" wrote a null time, so the
// FASTER a path was, the more it starved the inference that reschedules its own nudge.
// Stamping here rather than at each call site is what makes that one fix instead of
// three, and keeps the timezone authority server-side (#450) — a device clock is not
// the profile's clock.
//
// The stamp is bounded to the profile's TODAY. A late correction inside the 30-day
// window is a statement about a past day, and "now" is not that day's instant; those
// rows stay null rather than acquiring a fabricated one.
export function logPracticeSession(
  profileId: number,
  practice: string,
  date: string,
  opts: {
    time?: string | null;
    durationMin?: number | null;
    notes?: string | null;
    // WHICH MESSAGE'S TAP wrote this row (#2264/#2875) — the `notify_messages` row id,
    // or null for a tap no chat message produced (the web quick-sheet). Attribution,
    // not time: it decides WHERE a correction row may render, never what it says.
    notifyMessageId?: number | null;
  } = {}
): PracticeLogOutcome {
  const name = normalizePracticeName(practice);
  if (!name || !isPracticeDateAccepted(profileId, date)) {
    return { kind: "invalid-date" };
  }
  const stated =
    opts.time === undefined ? tapInstant(profileId, date) : (opts.time ?? null);
  const time = stated && /^\d{2}:\d{2}$/.test(stated) ? stated : null;
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
         (profile_id, practice, date, time, duration_min, notes,
          created_at, notify_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      name,
      date,
      time,
      durationMin,
      notes,
      // BOUND FROM THE CLOCK SEAM, not left to the column's SQL DEFAULT (#1534, and
      // #2287's refinement of it). `created_at` is this row's TAP stamp, and the
      // correction substrate subtracts it from a seam-derived now to decide whether a
      // burst is still fresh — so it is compared to the app's clock, not merely
      // displayed, which is exactly the test that says bind the seam. Under the e2e
      // freeze SQL's real clock and the seam are hours apart, and every practice burst
      // would read as long expired. In production the two are identical.
      sqlNow(),
      opts.notifyMessageId ?? null
    );
    const count = getPracticeDayCount(profileId, name, date);
    return { kind: "logged", count, date };
  });
}

// DAY-IDEMPOTENT practice logging — the offline queue's replay path (#2908, owner
// decision 3), and nothing else.
//
// #2130 excluded `practice-session` from the queue with a real argument, recorded on its
// coverage row: a practice is CADENCED, not idempotent, so the #2007 layer-3 same-day
// re-log confirm asks a question from the server-known session count that an offline
// capture cannot answer — and a blind replay could double-log a day already logged from
// another device with no confirm ever shown.
//
// This ANSWERS that argument rather than discarding it. The queued intent means
// "practice X happened on day D", with the dose flow's SET-TO semantics: insert only if
// that (practice-identity, day) holds no session, otherwise no-op. The confirm question
// never arises, because the second-session capture is exactly what this declines.
//
// The narrowing this buys and costs, stated plainly: offline logs a practice day ONCE.
// A genuine second same-day session still needs signal. That trade is the whole reason
// the flow can exist at all, and #2188's rhythm inference is why it must — a spuriously
// replayed session is a fabricated data point in a cadence model.
//
// The identity fold is `getPracticeDayCount`'s own (every stored spelling of the
// practice), so "already logged today" means the same thing here as on the card.
export type PracticeDayLogOutcome =
  | { kind: "logged"; count: number; date: string }
  | { kind: "already-logged"; count: number; date: string }
  | { kind: "invalid-date" };

export function logPracticeSessionForDay(
  profileId: number,
  practice: string,
  date: string,
  opts: { time?: string | null; durationMin?: number | null } = {}
): PracticeDayLogOutcome {
  const name = normalizePracticeName(practice);
  if (!name || !isPracticeDateAccepted(profileId, date)) {
    return { kind: "invalid-date" };
  }
  return writeTx((): PracticeDayLogOutcome => {
    const existing = getPracticeDayCount(profileId, name, date);
    if (existing > 0) return { kind: "already-logged", count: existing, date };
    const logged = logPracticeSession(profileId, name, date, opts);
    return logged.kind === "logged"
      ? logged
      : // Unreachable — the name and the date window are both checked above — but the
        // mapping stays total so a future refusal cannot fall through as a success.
        { kind: "invalid-date" };
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
// profile-local today (the tap's day).
//
// It passes NO `time`, which now means "stamp the tap" (#2204). It used to say that
// "Telegram stamps its own time-of-day for free" — which was never true of the ROW:
// the chat message carries a timestamp, `practice_logs.time` was written null, and
// #2202 then retimed this very nudge onto a typical-hour inference that this path was
// feeding nothing. A one-tap Done ✅ is a statement that the session is happening now,
// and that is what the row records.
export function logPracticeByTargetId(
  profileId: number,
  targetId: number,
  // The message this tap came from (#2264/#2875), stamped onto the row so the burst it
  // creates renders on THIS message and never on a sibling.
  notifyMessageId?: number | null
): PracticeLogOutcome {
  const row = db
    .prepare(
      `SELECT scope_value FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    )
    .get(targetId, profileId) as { scope_value: string } | undefined;
  if (!row) return { kind: "stale-target" };
  return logPracticeSession(profileId, row.scope_value, today(profileId), {
    notifyMessageId: notifyMessageId ?? null,
  });
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

// ---- Practice-time correction (issue #2875) ---------------------------------

// The typed result of a burst re-stamp:
//   restamped    — `count` rows now carry a corrected profile-local `time`.
//   no-burst     — the anchor row is gone, is no longer a tap (its `time` was cleared,
//                  or an import claimed it), or belongs to another profile. Nothing is
//                  written and the caller says so rather than confirming a correction
//                  that did not happen.
//   out-of-range — the resolver refused at least one row (a chip that would walk the
//                  burst past the floor, #2206).
//   crosses-day  — the answer lands on a DIFFERENT profile-local day. See below.
// The last three are ALL-OR-NOTHING: a burst is one error, so moving part of it would
// leave the ledger in a state no tap asked for.
export type PracticeRestampOutcome =
  | { kind: "restamped"; count: number }
  | { kind: "no-burst" }
  | { kind: "out-of-range" }
  | { kind: "crosses-day" };

// Re-stamp a whole burst's session time (issue #2875).
//
// The food and dose twins store an INSTANT, so their restamp is one column write and a
// cross-midnight correction simply re-dates the row. A practice stores a profile-local
// day plus an "HH:MM", so this core has to do two things they do not.
//
// IT WRITES BACK THROUGH THE PROFILE'S TIMEZONE. The resolver hands back an instant —
// the same `chipTarget` / `statedHourInstant` arithmetic both siblings use, so the chip
// labels and the write cannot disagree — and it is decomposed with `zonedDateParts`,
// the inverse of the `eventInstant` composition that produced `statedAt` in the first
// place. Server-side, per #450: a device clock is not the profile's clock.
//
// IT REFUSES TO CROSS LOCAL MIDNIGHT. Correcting a practice's DATE is explicitly out of
// scope — the chips move a time WITHIN a day, and a wrong-day session is the expanded
// form's job. That is not a detail to round off: writing "23:30" onto today's row when
// the user meant last night would be a fabrication, and `modalHour()` would then learn
// a typical hour from a session that never happened at it. So an answer landing on
// another day writes NOTHING and is spoken, rather than silently clamped.
//
// REPEAT TAPS COMPOSE (#2206), for free and for the same reason as the twins: the chip
// resolver counts back from `statedAt`, every tap reads its base inside this IMMEDIATE
// transaction, and a second callback against the same burst therefore reads what the
// first committed.
//
// A NULL `time` IS NEVER GIVEN ONE. Such rows are not in `getRecentPracticeTaps` at all,
// so they cannot be in a burst; the `time IS NOT NULL` filter is repeated in the re-read
// below so the property holds against the LEDGER at write time and not merely against
// whatever the renderer saw.
export function restampPracticeLogsCore(
  profileId: number,
  fromLogId: number,
  resolve: (row: { tapAt: string; statedAt: string | null }) => Date | null
): PracticeRestampOutcome {
  const tz = getTimezone(profileId);
  return writeTx(() => {
    // The burst is re-derived from the LEDGER at tap time, from the anchor id forward —
    // the token carries an id only, so which rows a chip moves is never a memory of what
    // some earlier keyboard rendered.
    const rows = db
      .prepare(
        `SELECT id, practice, date, time, created_at FROM practice_logs
          WHERE profile_id = ? AND id >= ?
            AND time IS NOT NULL AND external_id IS NULL
          ORDER BY created_at, id
          LIMIT 200`
      )
      .all(profileId, fromLogId) as {
      id: number;
      practice: string;
      date: string;
      time: string;
      created_at: string;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const events: TapEvent[] = [];
    for (const r of rows) {
      const tapAt = recordInstant("practice_logs", r);
      const statedAt = eventInstant("practice_logs", r, tz);
      if (!tapAt.known || !statedAt.known) continue;
      events.push({
        id: r.id,
        tapAt: tapAt.at,
        statedAt: statedAt.at,
        // The same stored column the refusal below compares against, so the burst this
        // core builds and the burst the renderer bounded its offers with carry ONE day
        // (#2875) — not the same day computed two ways.
        localDay: r.date,
        label: r.practice,
      });
    }
    const burst = burstFrom(events, fromLogId);
    if (!burst) return { kind: "no-burst" as const };

    // RESOLVE AND DECOMPOSE EVERY ROW BEFORE WRITING ANY. One refusal — the chip floor,
    // or a day boundary — refuses the whole burst.
    const targets = new Map<number, string>();
    const byIdEvent = new Map(events.map((e) => [e.id, e]));
    for (const id of burst.ids) {
      const row = byId.get(id);
      const event = byIdEvent.get(id);
      if (!row || !event) continue;
      const instant = resolve({
        tapAt: event.tapAt,
        statedAt: event.statedAt ?? null,
      });
      if (!instant) return { kind: "out-of-range" as const };
      const local = zonedDateParts(tz, instant);
      if (local.date !== row.date) return { kind: "crosses-day" as const };
      targets.set(id, local.hhmm);
    }

    for (const [id, hhmm] of targets) {
      // `edited` is the same mark the expanded form's correction sets: a human has
      // changed a value this app derived. These rows are never imported (the reader and
      // the re-read both exclude `external_id`), so it protects nothing here — it is set
      // because the two correction paths must agree about what a correction IS.
      db.prepare(
        `UPDATE practice_logs SET time = ?, edited = 1
          WHERE id = ? AND profile_id = ?`
      ).run(hhmm, id, profileId);
    }
    return { kind: "restamped" as const, count: targets.size };
  });
}
