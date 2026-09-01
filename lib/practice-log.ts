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
import { normalizePracticeName } from "./practice";
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
  getPracticeSpellings,
} from "./queries/wellness";
import { ADMIN_DEDUP_WINDOW_SEC } from "./queries/intake/adherence";

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
    derivedWindow?: boolean;
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
    if (loggedVia === "telegram-nudge" || loggedVia === "telegram-command") {
      const recent = db
        .prepare(
          `SELECT 1 FROM practice_logs
            WHERE profile_id = ? AND practice = ?
              AND logged_via IN ('telegram-nudge', 'telegram-command')
              AND ABS(strftime('%s', created_at) - strftime('%s', ?)) <= ?
            LIMIT 1`
        )
        .get(profileId, name, sqlNow(), ADMIN_DEDUP_WINDOW_SEC);
      if (recent)
        return {
          kind: "logged",
          count: getPracticeDayCount(profileId, name, date),
          date,
        };
    }
    db.prepare(
      `INSERT INTO practice_logs
         (profile_id, practice, date, start_time, end_time, duration_min, notes,
          created_at, notify_message_id, logged_via, live, derived_window)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      opts.live ? 1 : 0,
      opts.derivedWindow ? 1 : 0
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
    // Internal lifecycle close: preserve the durable derived-window marker only
    // when End is the second observed tap. History edits never set this.
    preserveDerivedWindow?: boolean;
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
    // the row stays on its original day, still has its start, and still has no stated
    // end. Supplying an end, clearing the start, or moving the row to another day is
    // an explicit completion/abandonment statement, so keeping `live = 1` would leave
    // an unendable or ended row offering "End session".
    const live =
      current.live === 1 &&
      input.date === current.date &&
      startTime === current.start_time &&
      startTime != null &&
      endTime == null &&
      durationMin == null
        ? 1
        : 0;
    const derivedWindow =
      current.derived_window === 1 &&
      (live === 1 || input.preserveDerivedWindow === true)
        ? 1
        : 0;
    const correctionLocked = input.preserveDerivedWindow
      ? current.correction_locked
      : 1;
    db.prepare(
      `UPDATE practice_logs
        SET date = ?, start_time = ?, end_time = ?, duration_min = ?, notes = ?,
            live = ?, derived_window = ?, correction_locked = ?, edited = 1
      WHERE id = ? AND profile_id = ?`
    ).run(
      input.date,
      startTime,
      endTime,
      durationMin,
      notes,
      live,
      derivedWindow,
      correctionLocked,
      id,
      profileId
    );
    const session = getPracticeSession(profileId, id);
    return session ? { kind: "updated", session } : { kind: "not-found" };
  });
}

// ── The live session's plausibility bound (#3143 review, the fasting shape) ─────
//
// Past this many hours an open lifecycle stops reading as "in progress" and starts
// reading as "you tapped Start and forgot", which is the same judgement
// `FAST_STALE_HOURS` makes one domain over. Six hours is longer than any practice this
// app is a logger for — a sauna, a meditation, a mobility block — and short enough that
// a Start tapped in the evening is abandoned before the next morning's page load. It is
// a plausibility bound, not a measurement.
export const LIVE_PRACTICE_STALE_HOURS = 6;

// Minutes this live row has been running at `at`, or null when it is no longer a
// session the app will complete: its start cannot be read, its start has not happened
// yet, or it has been open past the bound above.
//
// ELAPSED TIME, NOT A DAY LABEL, and that is the correction this replaces. The day
// comparison was widened from `<` to `<>` so a westward timezone edit could not strand
// a future-dated row — right about that case, and it is kept: a start in the future
// answers null here too. But NO day comparison can tell a 23:50→00:10 evening practice
// (twenty minutes, and the ordinary case) from a 28-hour-old forgotten Start, because
// both sit on a day that is not the profile's today. Measuring the elapsed span
// separates them, and the same quantity bounds the duration `End` derives — so the
// sweep and the write cannot disagree about what is still a session.
function liveElapsedMin(
  tz: string,
  row: { date: string; start_time: string | null },
  at: Date
): number | null {
  const started = eventInstant("practice_logs", row, tz);
  if (!started.known) return null;
  const minutes = (at.getTime() - Date.parse(started.at)) / 60_000;
  if (minutes < 0 || minutes > LIVE_PRACTICE_STALE_HOURS * 60) return null;
  return minutes;
}

// Close every unfinished lifecycle the bound above has given up on, without inventing
// an end. The row keeps exactly what was observed — `live` cleared, no end, no
// duration. Request gathers that render the offer state call this first; the
// transition is idempotent.
export function closeAbandonedPracticeSessions(profileId: number): number {
  const tz = getTimezone(profileId);
  const at = now();
  return writeTx(() => {
    const rows = db
      .prepare(
        `SELECT id, date, start_time FROM practice_logs
          WHERE profile_id = ? AND live = 1`
      )
      .all(profileId) as {
      id: number;
      date: string;
      start_time: string | null;
    }[];
    let closed = 0;
    for (const row of rows) {
      if (liveElapsedMin(tz, row, at) != null) continue;
      closed += db
        .prepare(
          `UPDATE practice_logs SET live = 0 WHERE id = ? AND profile_id = ?`
        )
        .run(row.id, profileId).changes;
    }
    return closed;
  });
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
    closeAbandonedPracticeSessions(profileId);
    const existing = openPracticeSession(profileId, name);
    if (existing) return { kind: "already-live" as const, session: existing };
    const outcome = logPracticeSession(profileId, name, date, loggedVia, {
      startTime: localStart.hhmm,
      live: true,
      derivedWindow: true,
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

// END the running session. The second tap of the two-tap window, so it must COMPLETE
// the row it is about — including the ordinary evening practice that runs past local
// midnight, which the day comparison here refused after sweeping the row away first.
//
// THE ROW KEEPS THE DAY IT STARTED ON. `date` is where a session is filed and counted;
// re-dating a 23:50 sauna into the small hours would move a logged day and, at a week
// boundary, a frequency target's credit. The stamped `end_time` is then simply earlier
// than the start, which `activityWindow` already reads as the crossing it is.
//
// THE DURATION COMES FROM THE ROW'S OWN START, not from its insert stamp. The start is
// what the row STATES — the first tap's instant, or a correction the user made to it —
// so deriving from `created_at` produced a window and a number that contradicted each
// other after a start edit (07:00→12:30 stored as 30 minutes) and let a stranded row
// self-heal into a 1710-minute session. Both halves now come from one quantity,
// computed as INSTANTS so a session across the spring DST jump is twenty minutes
// rather than eighty, and bounded by the same rule the sweep applies.
export function endLivePracticeSession(
  profileId: number,
  id: number
): PracticeLiveEndOutcome {
  return writeTx(() => {
    const endedAt = now();
    const tz = getTimezone(profileId);
    const current = getPracticeSession(profileId, id);
    if (!current || current.live !== 1) return { kind: "not-live" as const };
    const elapsed = liveElapsedMin(tz, current, endedAt);
    if (elapsed == null) {
      // Abandoned by the rule the sweep applies, so a stale End tap closes the row
      // rather than leaving it open for the next gather to find.
      closeAbandonedPracticeSessions(profileId);
      return { kind: "not-live" as const };
    }
    const updated = updatePracticeSession(profileId, id, {
      date: current.date,
      startTime: current.start_time,
      endTime: zonedDateParts(tz, endedAt).hhmm,
      durationMin: Math.max(1, Math.round(elapsed)),
      notes: current.notes,
      preserveDerivedWindow: true,
    });
    return updated.kind === "updated"
      ? {
          kind: "ended" as const,
          session: updated.session,
          count: getPracticeDayCount(profileId, current.practice, current.date),
          date: current.date,
        }
      : { kind: "not-live" as const };
  });
}

export function logFinishedPracticeSession(
  profileId: number,
  practice: string,
  loggedVia: LoggedVia,
  durationMin: number | null,
  notifyMessageId?: number | null,
  statedEnd?: { date: string; time: string }
): PracticeLogOutcome {
  const tz = getTimezone(profileId);
  const endedAt = now();
  const tappedEnd = zonedDateParts(tz, endedAt);
  const acceptedStatedEnd =
    statedEnd &&
    /^\d{4}-\d{2}-\d{2}$/.test(statedEnd.date) &&
    /^\d{2}:\d{2}$/.test(statedEnd.time)
      ? statedEnd
      : null;
  const end =
    acceptedStatedEnd != null
      ? { date: acceptedStatedEnd.date, hhmm: acceptedStatedEnd.time }
      : tappedEnd;
  const duration =
    durationMin != null && Number.isFinite(durationMin) && durationMin > 0
      ? Math.round(durationMin)
      : null;
  let start: { date: string; hhmm: string } | null = null;
  if (duration != null) {
    if (acceptedStatedEnd) {
      const [hour, minute] = end.hhmm.split(":").map(Number);
      let total = hour * 60 + minute - duration;
      let date = end.date;
      while (total < 0) {
        total += 24 * 60;
        date = shiftDateStr(date, -1);
      }
      start = {
        date,
        hhmm: `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`,
      };
    } else {
      start = zonedDateParts(
        tz,
        new Date(endedAt.getTime() - duration * 60_000)
      );
    }
  }
  const name = normalizePracticeName(practice);
  if (!name) return { kind: "invalid-date" };
  return writeTx(() => {
    // A JUST-FINISHED TAP WHILE A SESSION IS RUNNING ENDS THAT SESSION. Both taps are
    // the same statement ("that's done"), so a second row would double-log the day and
    // leave the lifecycle open — which is what Telegram's Done did, on a surface with
    // no End button to recover with. Only for a tap about NOW: a stated end is a claim
    // about some other, earlier moment, and the running row's end is not it. That
    // branch is unreachable from the web anyway (`whenShown` and the Just-finished
    // button are both gated on `!currentLive`), and Telegram states no end at all.
    const open = acceptedStatedEnd
      ? null
      : openPracticeSession(profileId, name);
    if (open) {
      const ended = endLivePracticeSession(profileId, open.id);
      if (ended.kind === "ended")
        return {
          kind: "logged" as const,
          count: ended.count,
          date: ended.date,
        };
      // The open row turned out to be abandoned — End has closed it — so this tap is
      // an ordinary just-finished statement rather than the second half of a lifecycle.
    }
    // IT FILES ON THE DAY THE END WAS STATED, tapped or typed. The end is the only
    // instant this statement carries; the start is arithmetic over a duration. Filing
    // on the derived start's day put a 00:20 tap on YESTERDAY, so today's count did not
    // move and at a week boundary the target's credit landed in the previous week. A
    // derived start that lands on another day cannot be expressed by a row that carries
    // one date, so it is left null rather than moved onto a day it did not happen on —
    // the end-only shape #3143 already defines, keeping its duration.
    return logPracticeSession(profileId, name, end.date, loggedVia, {
      startTime: start && start.date === end.date ? start.hhmm : null,
      endTime: end.hhmm,
      durationMin: duration,
      derivedWindow: duration != null,
      notifyMessageId: notifyMessageId ?? null,
    });
  });
}

// Log a session against a practice frequency TARGET id (#1259): resolve the target's
// practice NAME under profile scope, then log for TODAY.
// A deleted / cross-profile / non-practice target answers `stale-target` (the frozen-
// snapshot contract — the message may be stale) — nothing is written. The `date` is the
// profile-local today (the tap's day).
//
// TELEGRAM IS THE CALLER, AND IT IS THE ONE THAT NEEDS A RESOLVER. This was also the
// Upcoming web action's one-tap statement until #4424 ruling 7: that row mounts the
// shared control now, which posts a practice NAME resolved server-side beside the
// target read, so the web has nothing left to resolve here. A chat callback carries an
// id and no day, which is what keeps this function. Omitted `startTime` stamps the tap
// — the session is happening now. Telegram's explicit Done acknowledgement uses
// `logFinishedPracticeByTargetId` below instead.
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

// Telegram's Done button is a just-finished statement, not the "happening now" one the
// resolver above makes. Telegram shows no duration, so the only honest write is
// its observed end tap. A hidden usual duration must never fabricate a start.
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
    return logFinishedPracticeSession(
      profileId,
      row.scope_value,
      loggedVia,
      null,
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
// A NULL `start_time` IS NEVER GIVEN ONE. Telegram's just-finished tap stated its END;
// a correction moves that end and leaves the unknown start unknown.
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
            AND (end_time IS NULL OR (
              start_time IS NULL AND duration_min IS NULL AND correction_locked = 0
              AND logged_via IN ('telegram-nudge', 'telegram-command')
            ))
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
