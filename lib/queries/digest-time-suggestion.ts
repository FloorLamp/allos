// The DB gather behind the digest time suggestion (#2217). The DECISION is pure and
// lives in lib/digest-time-suggestion.ts; this resolves its four stored inputs — the
// digest's mode and time, the measured arrival distribution (#2214), the scheduler's
// OBSERVED tick cadence, and the profile's suppression rows — so both surfaces (the
// Settings row and the in-digest line) read exactly one answer.
//
// ONE FUNCTION, TWO SURFACES, ONE EPISODE KEY (constraint 5). The digest line and the
// Settings row are the SAME finding: dismissing either dismisses both, because both
// resolve here and the dismissal is one row on the shared suppression bus.

import { getSetting } from "../settings";
import {
  getNotifySchedule,
  getProfileSleepDigest,
} from "../settings/notifications";
import { getSleepArrivals } from "./metrics";
import { getFindingSuppressions } from "./upcoming/suppressions";
import { arrivalStatistics } from "../notifications/digest-schedule";
import {
  activeDigestTimeSuggestion,
  type DigestTimeSuggestion,
} from "../digest-time-suggestion";
import { today } from "../db";

// The scheduler's real cadence, from the watermark it writes each tick. Absent (the
// tick has never run) reads as hourly — the same fallback the Settings sub-hourly
// warning uses, and the widest, safest grid to snap a proposal onto.
export function observedTickMinutesSetting(): number {
  return Number(getSetting("notify_tick_interval_min")) || 60;
}

/**
 * This profile's live digest time suggestion, or null when there is nothing to say —
 * or when the episode has been dismissed and the distribution has not moved
 * materially since (`DIGEST_TIME_MATERIAL_MOVE_MIN`).
 */
export function getDigestTimeSuggestion(
  profileId: number
): DigestTimeSuggestion | null {
  const sched = getNotifySchedule(profileId);
  // Dynamic and Off both short-circuit before the arrival read, so a profile the
  // suggestion can never fire for pays nothing for it.
  if (sched.digestMinute == null || sched.digestMode !== "static") return null;
  // And so does a digest carrying no sleep at all (#2255). ONE gate here silences
  // BOTH surfaces, because both resolve through this function — the Settings card
  // conditions on the live checkbox for immediacy, and the next render agrees with it
  // because of this line. It sits above the arrival read for the same reason the two
  // gates above it do: a suggestion that cannot fire must not cost a 30-night join.
  const sleepSectionEnabled = getProfileSleepDigest(profileId);
  if (!sleepSectionEnabled) return null;
  return activeDigestTimeSuggestion(
    {
      mode: sched.digestMode,
      configuredMinute: sched.digestMinute,
      // Passed rather than assumed, even though the short-circuit above means it is
      // always true here: the RULE lives in the pure decision (and is unit-tested
      // there), and this is only the cheap early exit over it.
      sleepSectionEnabled,
      stats: arrivalStatistics(getSleepArrivals(profileId)),
      tickMinutes: observedTickMinutesSetting(),
    },
    getFindingSuppressions(profileId),
    today(profileId)
  );
}
