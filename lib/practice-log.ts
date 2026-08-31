// The DB seam for WELLNESS PRACTICE session logging (issue #1259): the one-tap write
// core plus the day/week reads over the dedicated `practice_logs` store. AUTH-BLIND and
// profileId-FIRST (the write-core convention) — no lib/auth import; the calling Server
// Action owns the auth gate. Every statement filters profile_id (practice_logs is a
// profile-owned table, enforced by the profile-scoping test). The pure range/pace
// decisions live in lib/practice.ts.

import { db, nowTime, today } from "./db";
import { writeTx } from "./db";
import type { LoggedVia } from "./logged-via";
import { shiftDateStr, zonedDateParts } from "./date";
import { TAP_REACH, isPastWriteAccepted } from "./log-manifest";
import { now, sqlNow } from "./clock";
import {
  burstFrom,
  type CorrectionBurst,
  type TapEvent,
} from "./correction-time";
import { eventInstant, recordInstant } from "./row-instants";
import { getTimezone } from "./settings";
import { normalizePracticeName, practiceDurationPrefill } from "./practice";
import type {
  PracticeLogOutcome,
  PracticeLiveEndOutcome,
  PracticeLiveStartOutcome,
  PracticeSessionDeleteOutcome,
  PracticeSessionMutationOutcome,
} from "./types";
import type { LivePracticeSession } from "./types";
import { captureDelete } from "./undo-delete-db";
import {
  getPracticeDayCount,
  getPracticeSession,
  getPracticeSessions,
  getPracticeSpellings,
} from "./queries/wellness";

// THE LAUNCHER'S REACH, not the domain's (owner ruling 2026-08-31). This was a ±30
// bound inside the write cores; it is now what the wellness page's log launcher
// OFFERS — its `minDate` — while the cores below take any real past day like every
// other domain's. Declared in `TAP_REACH` (#4425) and read from it here, so the offer
// and the number can never disagree.
export const PRACTICE_LOG_DATE_WINDOW_DAYS = TAP_REACH["practice-session"].back;

// The shared invariant, wearing the practice name: any real past day, never the
// future. It replaces BOTH the old ±30 log bound and the edit bound that accepted a
// date near the row being corrected — and that second one is why this is a tightening
// as well as an opening: "within 30 days of the current row" admitted a date up to
// thirty days in the FUTURE for an old imported session, which "never the future" now
// refuses. An imported session stays correctable in place, because its own day is past.
function isPracticeDateAccepted(profileId: number, date: string): boolean {
  return isPastWriteAccepted(today(profileId), date);
}

function inClause(values: readonly string[]): string {
  return values.map(() => "?").join(", ");
}

// The profile-local HH:MM a TAP happened at, or null when the row being written is
// not about today (see logPracticeSession's `start_time` contract). Reads the clock seam
// through `zonedMinuteStr`, so a frozen e2e instant stamps the frozen minute.
function tapInstant(profileId: number, date: string): string | null {
  return date === today(profileId) ? nowTime(profileId) : null;
}

// One-tap log a practice session. NOT idempotent — multi-session days are the point
// (#797 ledger model), so each accepted call appends a NEW row and returns the day's
// running count. `duration_min`/`notes` are optional. Returns a typed outcome — the
// caller answers from it, never unconditionally confirms.
//
// ---- `start_time`, and why the one-tap paths now carry one (#2204 part 2) -------
//
// `start_time` is deliberately THREE-valued, and the three values are three different
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
// The omitted case is new. Until #2202 nothing read the column, so
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
  // WHICH SURFACE LOGGED THIS SESSION (#3087) — required, no default. The one-tap
  // button is mounted on the Wellness page, the dashboard practice card and the
  // quick-log sheet, so this is the only thing that tells the three apart afterwards.
  loggedVia: LoggedVia,
  opts: {
    startTime?: string | null;
    endTime?: string | null;
    durationMin?: number | null;
    notes?: string | null;
    live?: boolean;
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
    opts.startTime === undefined
      ? tapInstant(profileId, date)
      : (opts.startTime ?? null);
  const startTime = stated && /^\d{2}:\d{2}$/.test(stated) ? stated : null;
  // `end_time` is two-valued, not three: a string or nothing. The detailed form can
  // state a window, and #3143's just-finished/end taps state their server-side local
  // minute; ordinary quick logs and imports state no end.
  const endTime =
    opts.endTime && /^\d{2}:\d{2}$/.test(opts.endTime) ? opts.endTime : null;
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
         (profile_id, practice, date, start_time, end_time, duration_min, notes,
          created_at, notify_message_id, logged_via, live)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      profileId,
      name,
      date,
      startTime,
      endTime,
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
      opts.notifyMessageId ?? null,
      loggedVia,
      opts.live ? 1 : 0
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
  loggedVia: LoggedVia,
  opts: { startTime?: string | null; durationMin?: number | null } = {}
): PracticeDayLogOutcome {
  const name = normalizePracticeName(practice);
  if (!name || !isPracticeDateAccepted(profileId, date)) {
    return { kind: "invalid-date" };
  }
  return writeTx((): PracticeDayLogOutcome => {
    const existing = getPracticeDayCount(profileId, name, date);
    if (existing > 0) return { kind: "already-logged", count: existing, date };
    const logged = logPracticeSession(profileId, name, date, loggedVia, opts);
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
    startTime?: string | null;
    endTime?: string | null;
    durationMin?: number | null;
    notes?: string | null;
  }
): PracticeSessionMutationOutcome {
  return writeTx(() => {
    const current = getPracticeSession(profileId, id);
    if (!current) return { kind: "not-found" };
    if (!isPracticeDateAccepted(profileId, input.date))
      return { kind: "invalid-date" };
    const startTime =
      input.startTime && /^\d{2}:\d{2}$/.test(input.startTime)
        ? input.startTime
        : null;
    const endTime =
      input.endTime && /^\d{2}:\d{2}$/.test(input.endTime)
        ? input.endTime
        : null;
    const durationMin =
      input.durationMin != null &&
      Number.isFinite(input.durationMin) &&
      input.durationMin > 0
        ? Math.round(input.durationMin)
        : null;
    const notes = input.notes?.trim() || null;
    // An ordinary edit cannot open a lifecycle row. It may preserve one only while
    // the row is still on the profile's today, still has its start, and still has no
    // stated end. Supplying an end, clearing the start, or moving the row to another
    // day is an explicit completion/abandonment statement, so keeping `live = 1`
    // would leave an unendable or ended row offering "End session".
    const live =
      current.live === 1 &&
      input.date === today(profileId) &&
      startTime != null &&
      endTime == null
        ? 1
        : 0;
    db.prepare(
      `UPDATE practice_logs
        SET date = ?, start_time = ?, end_time = ?, duration_min = ?, notes = ?,
            live = ?, edited = 1
      WHERE id = ? AND profile_id = ?`
    ).run(
      input.date,
      startTime,
      endTime,
      durationMin,
      notes,
      live,
      id,
      profileId
    );
    const session = getPracticeSession(profileId, id);
    return session ? { kind: "updated", session } : { kind: "not-found" };
  });
}

// Close yesterday's unfinished lifecycle without inventing an end. Request gathers
// that render the offer state call this first; the transition is idempotent.
export function closeAbandonedPracticeSessions(
  profileId: number,
  localDay = today(profileId)
): number {
  return writeTx(
    () =>
      db
        .prepare(
          `UPDATE practice_logs SET live = 0
        WHERE profile_id = ? AND live = 1 AND date < ?`
        )
        .run(profileId, localDay).changes
  );
}

function openPracticeSession(
  profileId: number,
  practice: string
): LivePracticeSession | null {
  const spellings = getPracticeSpellings(profileId, practice);
  if (spellings.length === 0) return null;
  const row = db
    .prepare(
      `SELECT id, date, start_time
         FROM practice_logs
        WHERE profile_id = ? AND live = 1
          AND practice IN (${inClause(spellings)})
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, ...spellings) as
    { id: number; date: string; start_time: string } | undefined;
  return row ? { id: row.id, date: row.date, startTime: row.start_time } : null;
}

export function startLivePracticeSession(
  profileId: number,
  practice: string,
  loggedVia: LoggedVia
): PracticeLiveStartOutcome {
  const name = normalizePracticeName(practice);
  if (!name) return { kind: "invalid-date" };
  return writeTx(() => {
    const localStart = zonedDateParts(getTimezone(profileId), now());
    const date = localStart.date;
    closeAbandonedPracticeSessions(profileId, date);
    const existing = openPracticeSession(profileId, name);
    if (existing) return { kind: "already-live" as const, session: existing };
    const outcome = logPracticeSession(profileId, name, date, loggedVia, {
      startTime: localStart.hhmm,
      live: true,
    });
    if (outcome.kind !== "logged") return { kind: "invalid-date" as const };
    const session = openPracticeSession(profileId, name);
    return session
      ? {
          ...outcome,
          kind: "started" as const,
          session,
        }
      : { kind: "invalid-date" as const };
  });
}

export function endLivePracticeSession(
  profileId: number,
  id: number
): PracticeLiveEndOutcome {
  return writeTx(() => {
    // One instant answers both questions: its profile-local day/minute is what the
    // row states, while its absolute distance from the start tap is the elapsed
    // duration. Subtracting HH:MM values would turn a 20-minute session across the
    // spring DST jump into 80 minutes (and loses the repeated hour in autumn).
    const endedAt = now();
    const localEnd = zonedDateParts(getTimezone(profileId), endedAt);
    const date = localEnd.date;
    closeAbandonedPracticeSessions(profileId, date);
    const current = getPracticeSession(profileId, id);
    if (!current || current.live !== 1 || current.date !== date)
      return { kind: "not-live" as const };
    const startTap = recordInstant("practice_logs", {
      created_at: current.created_at,
    });
    const elapsedMs = startTap.known
      ? endedAt.getTime() - new Date(startTap.at).getTime()
      : -1;
    const durationMin =
      elapsedMs >= 0 ? Math.max(1, Math.round(elapsedMs / 60_000)) : null;
    const updated = updatePracticeSession(profileId, id, {
      date,
      startTime: current.start_time,
      endTime: localEnd.hhmm,
      durationMin,
      notes: current.notes,
    });
    return updated.kind === "updated"
      ? {
          kind: "ended" as const,
          session: updated.session,
          count: getPracticeDayCount(profileId, current.practice, date),
          date,
        }
      : { kind: "not-live" as const };
  });
}

export function logFinishedPracticeSession(
  profileId: number,
  practice: string,
  loggedVia: LoggedVia,
  durationMin: number | null,
  notifyMessageId?: number | null
): PracticeLogOutcome {
  const endedAt = now();
  const tz = getTimezone(profileId);
  const end = zonedDateParts(tz, endedAt);
  const duration =
    durationMin != null && Number.isFinite(durationMin) && durationMin > 0
      ? Math.round(durationMin)
      : null;
  const start =
    duration == null
      ? null
      : zonedDateParts(tz, new Date(endedAt.getTime() - duration * 60_000));
  return logPracticeSession(
    profileId,
    practice,
    start?.date ?? end.date,
    loggedVia,
    {
      startTime: start?.hhmm ?? null,
      endTime: end.hhmm,
      durationMin: duration,
      notifyMessageId: notifyMessageId ?? null,
    }
  );
}

// Log a session against a practice frequency TARGET id (#1259): resolve the target's
// practice NAME under profile scope, then log for TODAY.
// A deleted / cross-profile / non-practice target answers `stale-target` (the frozen-
// snapshot contract — the message may be stale) — nothing is written. The `date` is the
// profile-local today (the tap's day).
//
// This is the Upcoming web action's ordinary one-tap statement: the session is
// happening now, so omitted `startTime` stamps the tap. Telegram's explicit Done
// acknowledgement uses `logFinishedPracticeByTargetId` below instead.
export function logPracticeByTargetId(
  profileId: number,
  targetId: number,
  loggedVia: LoggedVia,
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
  return logPracticeSession(
    profileId,
    row.scope_value,
    today(profileId),
    loggedVia,
    { notifyMessageId: notifyMessageId ?? null }
  );
}

// Resolve the Telegram button's default at tap time without putting health data in
// callback payloads. The target lookup and every duration row are profile-scoped;
// a leaked target id from another profile therefore reveals nothing.
export function practiceUsualDurationForTarget(
  profileId: number,
  targetId: number
): number | null {
  const row = db
    .prepare(
      `SELECT scope_value FROM frequency_targets
        WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
    )
    .get(targetId, profileId) as { scope_value: string } | undefined;
  if (!row) return null;
  return practiceDurationPrefill(
    getPracticeSessions(profileId, row.scope_value, 50)
  );
}

// Telegram's Done button is a just-finished statement, not the Upcoming page's
// "happening now" statement. Resolve the usual duration and write the derived window
// under one IMMEDIATE transaction, so a concurrent target edit cannot pair one
// practice's duration with another practice's row. The callback remains
// practice-identity-only; no duration is carried through Telegram.
export function logFinishedPracticeByTargetId(
  profileId: number,
  targetId: number,
  loggedVia: LoggedVia,
  notifyMessageId?: number | null
): PracticeLogOutcome {
  return writeTx(() => {
    const row = db
      .prepare(
        `SELECT scope_value FROM frequency_targets
          WHERE id = ? AND profile_id = ? AND scope_kind = 'practice'`
      )
      .get(targetId, profileId) as { scope_value: string } | undefined;
    if (!row) return { kind: "stale-target" };
    const durationMin = practiceDurationPrefill(
      getPracticeSessions(profileId, row.scope_value, 50)
    );
    return logFinishedPracticeSession(
      profileId,
      row.scope_value,
      loggedVia,
      durationMin,
      notifyMessageId ?? null
    );
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
//   restamped    — `count` rows now carry a corrected profile-local `start_time`.
//   no-burst     — the anchor row is gone, is no longer a tap (its `start_time` was
//                  cleared, an import claimed it, or it now carries a stated window),
//                  or belongs to another profile. Nothing is
//                  written and the caller says so rather than confirming a correction
//                  that did not happen.
//   out-of-range — the resolver refused at least one row (a chip that would walk the
//                  burst past the floor, #2206).
//   crosses-day  — the answer lands on a DIFFERENT profile-local day. See below.
// The last three are ALL-OR-NOTHING: a burst is one error, so moving part of it would
// leave the ledger in a state no tap asked for.
// A fifth refusal joined them (#3092 follow-up): not-bound — the caller's `stillBound`
// guard refused the re-derived burst, which by write time no longer belongs to the
// message the tap came from. Nothing written.
export type PracticeRestampOutcome =
  | { kind: "restamped"; count: number }
  | { kind: "no-burst" }
  | { kind: "out-of-range" }
  | { kind: "crosses-day" }
  | { kind: "not-bound" };

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
// A NULL `start_time` IS NEVER GIVEN ONE except when a Telegram just-finished row has a
// stored usual duration. That row's tap stated its END; a correction moves that end and
// re-derives the same duration window. Without a duration, its start remains null.
//
// A SESSION CARRYING A USER-STATED WINDOW NEVER JOINS A BURST (#3142). The only ended
// rows admitted here are Telegram quick acknowledgements, identified by their immutable
// provenance. The same predicate is repeated in `getRecentPracticeTaps`, so the
// renderer and the write always bound the same rows.
export function restampPracticeLogsCore(
  profileId: number,
  fromLogId: number,
  resolve: (row: { tapAt: string; statedAt: string | null }) => Date | null,
  // The tap-time binding, re-evaluated INSIDE this write transaction (#3092 follow-up).
  // The handler's own check runs before its write call, but an `await` separates the
  // two, and a concurrent handler's pointer delete landing in that gap re-merges the
  // anchor into the null partition — so the burst the transaction re-derives is the one
  // the binding must hold FOR. The caller builds this from the SAME predicate its
  // renderer used (`burstsForMessage` + `correctionMessageBinding`); a chat-less caller
  // passes nothing and keeps the unguarded behavior.
  stillBound?: (burst: CorrectionBurst) => boolean
): PracticeRestampOutcome {
  const tz = getTimezone(profileId);
  return writeTx(() => {
    // The burst is re-derived from the LEDGER at tap time, from the anchor id forward —
    // the token carries an id only, so which rows a chip moves is never a memory of what
    // some earlier keyboard rendered.
    const rows = db
      .prepare(
        `SELECT id, practice, date, start_time, end_time, duration_min, logged_via,
                created_at, notify_message_id
           FROM practice_logs
          WHERE profile_id = ? AND id >= ?
            AND (start_time IS NOT NULL OR end_time IS NOT NULL)
            AND (end_time IS NULL OR logged_via IN ('telegram-nudge', 'telegram-command'))
            AND live = 0
            AND external_id IS NULL
          ORDER BY created_at, id
          LIMIT 200`
      )
      .all(profileId, fromLogId) as {
      id: number;
      practice: string;
      date: string;
      start_time: string | null;
      end_time: string | null;
      duration_min: number | null;
      logged_via: string | null;
      created_at: string;
      notify_message_id: number | null;
    }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const events: TapEvent[] = [];
    for (const r of rows) {
      const tapAt = recordInstant("practice_logs", r);
      const chatFinished =
        r.end_time != null &&
        (r.logged_via === "telegram-nudge" ||
          r.logged_via === "telegram-command");
      const endDate =
        chatFinished && r.start_time != null && r.end_time! <= r.start_time
          ? shiftDateStr(r.date, 1)
          : r.date;
      const statedAt = eventInstant(
        "practice_logs",
        chatFinished ? { ...r, date: endDate, start_time: r.end_time } : r,
        tz
      );
      if (!tapAt.known || !statedAt.known) continue;
      events.push({
        id: r.id,
        tapAt: tapAt.at,
        statedAt: statedAt.at,
        // The same stored column the refusal below compares against, so the burst this
        // core builds and the burst the renderer bounded its offers with carry ONE day
        // (#2875) — not the same day computed two ways.
        localDay: r.date,
        // A burst is one message's error (#3092): the write partitions by the same
        // provenance the renderer partitioned by, so a chip re-stamps exactly the
        // rows whose correction row it was.
        messageRef: r.notify_message_id,
        label: r.practice,
      });
    }
    const burst = burstFrom(events, fromLogId);
    if (!burst) return { kind: "no-burst" as const };
    if (stillBound && !stillBound(burst)) return { kind: "not-bound" as const };

    // RESOLVE AND DECOMPOSE EVERY ROW BEFORE WRITING ANY. One refusal — the chip floor,
    // or a day boundary — refuses the whole burst.
    const targets = new Map<
      number,
      { start: string | null; end: string | null }
    >();
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
      const chatFinished =
        row.end_time != null &&
        (row.logged_via === "telegram-nudge" ||
          row.logged_via === "telegram-command");
      const endDate =
        chatFinished &&
        row.start_time != null &&
        row.end_time! <= row.start_time
          ? shiftDateStr(row.date, 1)
          : row.date;
      const local = zonedDateParts(tz, instant);
      if (local.date !== endDate) return { kind: "crosses-day" as const };
      if (chatFinished) {
        const start =
          row.duration_min != null
            ? zonedDateParts(
                tz,
                new Date(instant.getTime() - row.duration_min * 60_000)
              )
            : null;
        if (start && start.date !== row.date)
          return { kind: "crosses-day" as const };
        targets.set(id, {
          start: start?.hhmm ?? null,
          end: local.hhmm,
        });
      } else {
        targets.set(id, {
          start: local.hhmm,
          end: null,
        });
      }
    }

    for (const [id, target] of targets) {
      // `edited` is the same mark the expanded form's correction sets: a human has
      // changed a value this app derived. These rows are never imported (the reader and
      // the re-read both exclude `external_id`), so it protects nothing here — it is set
      // because the two correction paths must agree about what a correction IS.
      db.prepare(
        `UPDATE practice_logs SET start_time = ?, end_time = ?, edited = 1
          WHERE id = ? AND profile_id = ?`
      ).run(target.start, target.end, id, profileId);
    }
    return { kind: "restamped" as const, count: targets.size };
  });
}
