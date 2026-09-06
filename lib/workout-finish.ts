// The shared, auth-blind, id-keyed workout-FINISH write core (issues #1124 / #1205,
// #221). The live-panel Finish (in-app) and the plain-form Finish (#1124) persist
// through the form's auto-save; this headless core is what the OFF-app entrypoints
// use — the "Still working out?" Telegram nudge's Finish button (#1205) — and any
// future programmatic finish, so every finish path stamps end the SAME way and can't
// diverge. profileId-first, no lib/auth import (the calling Server Action / callback
// handler owns the auth + cross-profile gate); every statement is profile-scoped.
//
// "Finish" = stamp `end_time` (profile-local wall clock) on the persisted live draft,
// filling `duration_min` (active minutes) from the start→end span when it was still
// null, so the finished session reads as completed everywhere (presence, load, the
// post-workout dose dispatch). Idempotent + low-risk: a re-tap on an already-finished
// session is a no-op, and a stale draft (quiet by definition, #560) has no live client
// edits to race (#467). Every caller answers from the typed outcome union — never an
// unconditional confirm.
//
// THE MINUTE STAMPED IS THE ONE THE HEART RATE SAYS, and `now` is the fallback (#5194,
// owner ruling 2026-09-06). A tap an hour after the fact used to record the tap: a
// session that ended at 11:35 was finished at 12:30, and the recovery, the zone split
// and the recap were all measured over an hour of sitting down. Nothing here runs
// unattended: the detector PROPOSES and this core runs only from a person's Finish, so
// the correction rides the finish path that already exists rather than a second writer,
// and it is #5142 AC 3's want for the same tap.
//
// WHAT THE PERSON WAS SHOWN WINS OVER ANY LATER READING, and that ordering is the whole
// of #5194's eighth falsifying pass. The "Still working out?" nudge quotes the minute
// when it is SENT; this core used to ask the detector again when the button was TAPPED,
// and between the two the trace moves — one measured minute six bpm above the resting
// ceiling is enough for the detector to refuse, so a message naming 16:35 wrote 18:30
// and a hundred and fifty minutes, and said nothing about it. A proposal that changes
// between being shown and being accepted is not a proposal. So a delivered message
// records its minute against the row (lib/workout-end-proposal.ts) and the tap stamps
// THAT — including its "no minute", which promises the tap's own instant.
//
// A tap with nothing on record is a finish nobody was shown a minute for — the request
// path below, and any future programmatic finish. There is no promise to keep there, so
// the trace is read once, at the tap, exactly as this core has done since it landed.
//
// IT IS THIS CORE'S CALLERS AND NOT EVERY FINISH IN THE APP. The in-app Finish is the
// activity form's own (`ActivityForm.tsx`, end field := now, persisted by the autosave);
// it does not come through here and is unchanged.

import { db, writeTx } from "./db";
import type { LoggedVia } from "./logged-via";
import { now as clockNow, sqlNow } from "./clock";
import { utcSqlString, zonedDateParts } from "./date";
import { minutesBetween } from "./activity-meta";
import { getTimezone } from "./settings/display";
import { parseComponents } from "./types/training";
import { detectedWorkoutEndAt } from "./workout-detected-end";
import {
  clearWorkoutEndProposal,
  readWorkoutEndProposal,
} from "./workout-end-proposal";

export type FinishWorkoutOutcome =
  | { kind: "finished"; activityId: number }
  | { kind: "already-finished"; activityId: number }
  | { kind: "empty-draft"; activityId: number }
  | { kind: "not-found" };

export interface StartWorkoutResult {
  id: number;
  date: string;
  startTime: string;
}

// The START half of the same lifecycle (#2870 step 3, create-at-start): starting
// a live session writes its row UP FRONT — the canonical activity page needs an
// id in its URL, presence needs a row before other devices can see the session,
// and the editor updates this row from its first save instead of holding a
// rowless create. The inserted shape IS the live-draft signature
// computeWorkoutPresence reads (started, unended, duration-less, source-less),
// so presence turns active the moment this commits. An abandoned zero-content
// row is a DRAFT (#1205 §4): discardWorkoutSession below removes it.
export function startWorkoutSession(
  profileId: number,
  opts: { type: "strength" | "cardio"; title: string },
  loggedVia: LoggedVia,
  now: Date = clockNow()
): StartWorkoutResult {
  const tz = getTimezone(profileId);
  const { date, hhmm } = zonedDateParts(tz, now);
  const id = writeTx(() =>
    Number(
      db
        .prepare(
          `INSERT INTO activities (profile_id, date, type, title, start_time, updated_at, logged_via)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(profileId, date, opts.type, opts.title, hhmm, sqlNow(), loggedVia)
        .lastInsertRowid
    )
  );
  return { id, date, startTime: hhmm };
}

export type DiscardWorkoutOutcome =
  | { kind: "discarded"; activityId: number }
  | { kind: "already-finished"; activityId: number }
  | { kind: "not-found" };

export type DiscardEmptyOutcome = DiscardWorkoutOutcome | { kind: "kept" };

interface DraftRow {
  id: number;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  components: string | null;
  notes: string | null;
  distance_km: number | null;
  source: string | null;
}

function loadDraft(profileId: number, activityId: number): DraftRow | null {
  const row = db
    .prepare(
      `SELECT id, start_time, end_time, duration_min, components, notes,
              distance_km, source
         FROM activities WHERE id = ? AND profile_id = ?`
    )
    .get(activityId, profileId) as DraftRow | undefined;
  return row ?? null;
}

// Whether the draft has any logged content — a set, a component, a note, or a
// distance ("zero sets/values" is the draft bar, and a note IS a value). A
// finish must never turn an empty started-but-nothing-logged draft into a
// 0-content activity (#1205 §4): that path returns `empty-draft` (Discard
// instead) — and the if-empty discard below must never delete one the user
// put anything into.
function hasLoggedContent(row: DraftRow): boolean {
  const setCount = (
    db
      .prepare("SELECT COUNT(*) AS c FROM exercise_sets WHERE activity_id = ?")
      .get(row.id) as { c: number }
  ).c;
  return (
    setCount > 0 ||
    parseComponents(row.components).length > 0 ||
    (row.notes ?? "").trim() !== "" ||
    row.distance_km != null
  );
}

// Stamp the end on a live draft. See the file header for the contract.
export function finishWorkoutSession(
  profileId: number,
  activityId: number,
  now: Date = clockNow()
): FinishWorkoutOutcome {
  const row = loadDraft(profileId, activityId);
  // A missing row, or a source-owned import (never a live in-app draft), is not
  // finishable here — the stale nudge only fires for manual/live sessions anyway.
  if (!row || row.source) return { kind: "not-found" };
  if (row.end_time) return { kind: "already-finished", activityId };
  if (!hasLoggedContent(row)) return { kind: "empty-draft", activityId };

  const tz = getTimezone(profileId);
  // THE PROPOSAL FIRST, AND A FRESH READING ONLY WHEN THERE WAS NONE — see the header.
  // A recorded proposal is what a delivered message told this person Finish would do, so
  // it answers on its own, `null` minute included; asking the detector on top of it is
  // the second reading that made the two disagree.
  const shown = readWorkoutEndProposal(profileId, activityId);
  // Asked AFTER the refusals, so a husk or a foreign id costs no heart-rate read — and
  // not at all when a message already proposed this row's end.
  const detected = shown ? null : detectedWorkoutEndAt(profileId, activityId);
  const hhmm =
    (shown ? shown.minute : detected && zonedDateParts(tz, detected).hhmm) ??
    zonedDateParts(tz, now).hhmm;
  // Active minutes: fill from the start→end span only when none is stored yet
  // (a strength session's session-total). Never overwrite a value the logger set.
  const duration =
    row.duration_min ??
    (row.start_time ? minutesBetween(row.start_time, hhmm) : null);
  // `updated_at` binds the CLOCK SEAM (#2287): it is the liveness stamp
  // computeWorkoutPresence subtracts from a seam-derived now (lastTouchMs), so writing
  // it from SQL's own clock puts the two sides of that subtraction on different clocks.
  // Inert in production, where the seam is real. It is the TAP's instant even when the
  // end is back-dated — the row was touched now, whenever the effort ended.
  writeTx(() => {
    db.prepare(
      `UPDATE activities
         SET end_time = ?, duration_min = ?, updated_at = ?
       WHERE id = ? AND profile_id = ?`
    ).run(hhmm, duration, sqlNow(), activityId, profileId);
    // The proposal is SPENT in the same transaction that honours it: this row has an
    // end now, so nothing can be proposed about it again (the refusal above), and a
    // record that outlives its row is only litter.
    clearWorkoutEndProposal(profileId, activityId);
  });
  return { kind: "finished", activityId };
}

// Discard a live draft (#1205 §4): delete the started-but-abandoned session and its
// sets. Refuses a finished session (nothing to discard) and a foreign/absent id.
export function discardWorkoutSession(
  profileId: number,
  activityId: number
): DiscardWorkoutOutcome {
  const row = loadDraft(profileId, activityId);
  if (!row || row.source) return { kind: "not-found" };
  if (row.end_time) return { kind: "already-finished", activityId };
  writeTx(() => {
    db.prepare("DELETE FROM exercise_sets WHERE activity_id = ?").run(
      activityId
    );
    db.prepare("DELETE FROM activities WHERE id = ? AND profile_id = ?").run(
      activityId,
      profileId
    );
    // The other half of the nudge's two buttons resolves the row too, so its proposal
    // goes with it. Ids never recycle (#203), so this is tidiness rather than safety.
    clearWorkoutEndProposal(profileId, activityId);
  });
  return { kind: "discarded", activityId };
}

// Auto-expiry (#2870 step 3, owner-ruled: a zero-content unfinished activity
// is a draft — auto-expire it). A husk older than DRAFT_EXPIRE_HOURS by last
// touch is deleted by the notify tick's per-profile housekeeping; anything
// with content (same bar as the close-path abandonment) is exempt, and the
// live-draft shape already excludes finished and source-owned rows. 24 hours:
// long enough that a phone dying mid-session never loses the address a user
// might return to, short enough that husks don't outlive the day they meant.
export const DRAFT_EXPIRE_HOURS = 24;

export function expireWorkoutDrafts(
  profileId: number,
  now: Date = clockNow()
): number {
  const cutoff = utcSqlString(
    new Date(now.getTime() - DRAFT_EXPIRE_HOURS * 3_600_000)
  );
  const rows = db
    .prepare(
      `SELECT id, start_time, end_time, duration_min, components, notes,
              distance_km, source
         FROM activities
        WHERE profile_id = ? AND source IS NULL AND end_time IS NULL
          AND start_time IS NOT NULL AND duration_min IS NULL
          AND COALESCE(updated_at, created_at) < ?`
    )
    .all(profileId, cutoff) as DraftRow[];
  let expired = 0;
  for (const row of rows) {
    if (hasLoggedContent(row)) continue;
    if (discardWorkoutSession(profileId, row.id).kind === "discarded")
      expired++;
  }
  return expired;
}

// Discard ONLY IF EMPTY (#2870 step 3): closing a live session that never
// logged anything abandons its create-at-start row — without this, the empty
// draft keeps presence "active" for 90 minutes and the resume bar haunts every
// page offering a session with nothing in it. Server-authoritative on
// emptiness (the close-path flush lands before this runs, so a just-saved set
// KEEPS the row), and it reuses discard's own refusals for finished/foreign
// rows.
export function discardWorkoutSessionIfEmpty(
  profileId: number,
  activityId: number
): DiscardEmptyOutcome {
  const row = loadDraft(profileId, activityId);
  if (!row || row.source) return { kind: "not-found" };
  if (row.end_time) return { kind: "already-finished", activityId };
  if (hasLoggedContent(row)) return { kind: "kept" };
  return discardWorkoutSession(profileId, activityId);
}
