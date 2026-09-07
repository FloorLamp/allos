// WHAT THE MESSAGE PROPOSED, so the tap stamps THAT and not a second reading
// (#5194, the eighth falsifying pass, F1).
//
// The detected end is a PROPOSAL: the "Still working out?" nudge quotes the minute
// this profile's own heart rate says the effort ended, and the person's Finish is what
// writes it (owner ruling, 2026-09-06 — the detector proposes, the person disposes).
// The first shipped version asked the detector TWICE — once when the message was sent
// and again when the button was tapped — and a proposal that is re-derived hours later
// is not the proposal that was shown:
//
//   MESSAGE SENT AT 17:20 : "Your heart rate says it ended at 16:35. Finish it at that
//                            minute or discard the draft…"
//     … a fifteen-minute dog walk at 17:45, then the thumb at 18:30 …
//   ROW AFTER THE TAP     : end_time 18:30, duration_min 150
//
// One measured minute six bpm above the resting ceiling anywhere later in the day is
// enough: a second effort means the trace no longer says unambiguously, the detector
// correctly refuses, and the tap falls back to its own instant — the exact defect
// #5194 opens with, delivered silently by the feature built to fix it. A save between
// the send and the tap does the same through the `updated_at` cancel, and the reverse
// direction (a watch that syncs AFTER the message quoted nothing) is the same mechanism
// from the other side.
//
// ── THE FIX IS TO REMEMBER, NOT TO RE-MEASURE ────────────────────────────────
// The minute a delivered message names is recorded HERE and the finish core stamps the
// recorded value. A trace that moves afterwards cannot change what lands, because
// nothing reads the trace again. The token could not carry it —
// `sgfinish:workout:<profile>:<row>` is already in people's chats and must stay
// byte-identical — so the tap looks the proposal up by the row id the token does carry.
//
// A message that quoted NO minute is recorded too, as `NO_MINUTE`. That is not
// bookkeeping tidiness: "Your session has been quiet for a while. Finish it or discard"
// promises the tap's own instant, so a detector that starts answering between the send
// and the tap must not silently back-date the row either. One record, both directions.
//
// ── REMEMBERING IS NOT THE SAME AS BEING RIGHT FOREVER ───────────────────────
// The record is authoritative about what was SHOWN, and nothing more. It does not
// survive the person contradicting it: `finishWorkoutSession` re-applies the detector's
// own cancel to the recorded minute at tap time, so a save past that minute — someone
// who went back to the rack after the nudge and lifted for another hour — refuses the
// promise and the tap stamps its own instant (#5194, ninth falsifying pass). The value
// is only ever taken from here; the cancel only ever says no.
//
// ── WHY PROFILE SETTINGS AND NOT A TABLE ─────────────────────────────────────
// This is the second per-row fact the same nudge already keeps about the same row: the
// one-shot marker (`notify_stale_workout_<id>`, lib/notifications/still-going.ts) is the
// first. It gets the same storage and the same discipline — keyed by row id, ids never
// recycle (#203), and a record left behind by a row that was never resolved is a
// harmless dead setting. `notify_offers` (lib/notifications/offer-store.ts) is the other
// candidate substrate and is the wrong one twice over: its rows are addressed by an
// offer id the token has to carry, and its contract is that a stored offer is an UPPER
// BOUND re-derived at redemption — which is precisely the re-derivation this defect is.

import {
  deleteProfileSetting,
  getProfileSetting,
  setProfileSetting,
} from "./settings/kv";

// Sibling of STALE_WORKOUT_MARKER_PREFIX, and deliberately a different prefix: the
// marker answers "was this row nudged", this answers "what did that nudge say".
export const WORKOUT_END_PROPOSAL_PREFIX = "notify_end_proposal_workout_";

export function workoutEndProposalKey(rowId: number): string {
  return `${WORKOUT_END_PROPOSAL_PREFIX}${rowId}`;
}

// "The message went out and named no minute" — distinct from "no message went out",
// which is the absence of the key. A stored `HH:MM` is every other value.
const NO_MINUTE = "-";

/** What a delivered nudge proposed for one open workout row. */
export interface WorkoutEndProposal {
  // The profile-local `HH:MM` the message quoted, or null when it quoted none. It is a
  // wall minute rather than an instant because it is the value `end_time` stores and
  // the value the sentence printed — the two must be the same characters.
  minute: string | null;
}

/**
 * Record what a message proposed, once that message has actually been delivered.
 *
 * ON DELIVERY, not before it. Writing before the dispatch was the first shape and it
 * recorded proposals for messages that were never sent — a profile with no channel at
 * all reaches the nudge loop on every eligible tick — which `finishWorkout` would then
 * honour on a tap for a message nobody received. The header argued that cost was
 * bounded by the next tick overwriting the record; arithmetic says otherwise, because
 * `EPISODE_BOUNDS.workout` is 45–90 minutes wide and the tick is hourly, so the tick
 * after the one that recorded is already past the window and there is no retry.
 *
 * DELIVERY IS A FACT ABOUT RECIPIENTS, NOT ABOUT CHANNELS, and that distinction is the
 * whole of what makes the sentence above true. The caller writes this in the branch the
 * one-shot marker shares, gated on `DispatchResult.delivered` — at least one recipient
 * received the message — rather than on the channel's `ok`. Gating on `ok` failed both
 * ways at once: Telegram fans one message out to every managing login's chat and fails
 * whole when one of them has blocked the bot, so a household chat held a live Finish
 * button for a minute nothing had recorded; and Web Push reports success having reached
 * nobody when every subscription answers 404/410 Gone, since each one is pruned without
 * counting a success or an error and the channel never throws (#5194, eleventh pass —
 * an earlier version of this sentence named the per-kind audience gate instead, which
 * cannot filter this family at all: the nudge is `kind: "other"`, `other` is in
 * `NON_CONFIGURABLE_KINDS`, and `parseDisabledKinds` strips it from every stored blob).
 * The only unwritten window left is a crash between the record and the marker, which
 * re-sends and re-records, plus a send abandoned at the dispatch deadline (#3057) that
 * lands afterwards — `dispatch` discards that late answer rather than being unable to
 * see it (`onLateSettle` logs it), so it is counted as undelivered.
 *
 * RETENTION. One row per nudged workout, spent inside the finish or discard transaction
 * that resolves that row (`lib/workout-finish.ts`). THREE paths leave one behind: a
 * draft nobody ever resolves; a row ended by the activity form's own save, which
 * persists through `lib/activity-write.ts` and never reaches that core; and a nudged
 * draft whose sets are then all deleted, which answers `empty-draft` before the write
 * transaction (#5194, tenth pass — the docblock said two). All three are inert and stay
 * forever — ids never recycle (#203), so a stranded record can only ever be read about
 * the row it names, and that row is either ended, which `finishWorkoutSession` refuses
 * before it looks anything up, or a husk `expireWorkoutDrafts` deletes at 24 hours,
 * spending the record with it. It is a dead setting on exactly the terms of the one-shot
 * marker it is written beside, and it is swept the same way that one is: not at all.
 */
export function recordWorkoutEndProposal(
  profileId: number,
  activityId: number,
  minute: string | null
): void {
  setProfileSetting(
    profileId,
    workoutEndProposalKey(activityId),
    minute ?? NO_MINUTE
  );
}

/** What the person was shown for this row, or null when they were shown nothing. */
export function readWorkoutEndProposal(
  profileId: number,
  activityId: number
): WorkoutEndProposal | null {
  const stored = getProfileSetting(
    profileId,
    workoutEndProposalKey(activityId)
  );
  if (stored == null) return null;
  return { minute: stored === NO_MINUTE ? null : stored };
}

/**
 * Spend the proposal: the row it was about has been finished or discarded through the
 * shared core. See `recordWorkoutEndProposal` for what is NOT spent this way.
 */
export function clearWorkoutEndProposal(
  profileId: number,
  activityId: number
): void {
  deleteProfileSetting(profileId, workoutEndProposalKey(activityId));
}
