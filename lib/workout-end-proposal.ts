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
// The minute a delivered message names is recorded HERE before it is sent, and the
// finish core stamps the recorded value. A trace that moves afterwards cannot change
// what lands, because nothing reads the trace again. The token could not carry it —
// `sgfinish:workout:<profile>:<row>` is already in people's chats and must stay
// byte-identical — so the tap looks the proposal up by the row id the token does carry.
//
// A message that quoted NO minute is recorded too, as `NO_MINUTE`. That is not
// bookkeeping tidiness: "Your session has been quiet for a while. Finish it or discard"
// promises the tap's own instant, so a detector that starts answering between the send
// and the tap must not silently back-date the row either. One record, both directions.
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
 * Record what THIS message proposes, immediately before it is dispatched.
 *
 * Before, rather than after a successful send: the invariant that matters is "every
 * delivered message's minute is on record", and recording after leaves a window in
 * which a delivered message has none. The opposite cost is a record for a send that
 * failed, which nothing can consume except a later finish of the same row — and the
 * next tick, still holding no one-shot marker, overwrites it with what it quotes.
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

/** Spend the proposal: the row it was about has been finished or discarded. */
export function clearWorkoutEndProposal(
  profileId: number,
  activityId: number
): void {
  deleteProfileSetting(profileId, workoutEndProposalKey(activityId));
}
