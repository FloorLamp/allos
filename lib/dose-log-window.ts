// Pure acceptance windows for dose/administration timestamps — no DB/network, so
// unit-tested in lib/__tests__. Shared by the scheduled-dose date guard
// (isDoseDateAccepted) and the PRN given_at guard (#614 extended to #797's
// user-suppliable intake time).

import { daysBetweenDateStr, dateStrInTz } from "./date";

// A late/retro dose-log DATE is accepted only within a small window of the profile's
// today (#614): a forged/far-off date can't land a misdated row, but a legitimate
// late/after-midnight tap within the window still logs to the reminder's own day.
export const DOSE_LOG_DATE_WINDOW_DAYS = 2;

// Is `date` (YYYY-MM-DD) inside the accepted window around the profile's today? The
// ONE realization of that rule (#1427): the scheduled write cores (markDoseTaken /
// markDoseSkipped) gate on it, and the offline replay consults the SAME predicate to
// tell an out-of-window entry apart from a deleted dose when it explains the refusal
// — one computation, never a second copy that could drift. Pure: `todayStr` is the
// caller's already-resolved profile today.
export function isDoseDateAccepted(todayStr: string, date: string): boolean {
  const diff = daysBetweenDateStr(todayStr, date);
  return diff != null && Math.abs(diff) <= DOSE_LOG_DATE_WINDOW_DAYS;
}

// A user-suppliable given_at (PRN retro entry, #797) additionally must not be
// meaningfully in the FUTURE — a genuinely future time is a typo/forgery. A small
// skew tolerates clock differences between the client and server.
export const GIVEN_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Whether a supplied given_at instant is acceptable, given the profile timezone, its
// today (YYYY-MM-DD), and "now": not in the future past the skew, and its profile-
// local date within DOSE_LOG_DATE_WINDOW_DAYS of today (so a same-day or recent retro
// time lands, a far-off/forged one doesn't). Pure — `now` is injected so it's fully
// deterministic in a unit test.
export function isGivenAtAccepted(
  tz: string,
  todayStr: string,
  givenAt: Date,
  now: Date = new Date()
): boolean {
  if (Number.isNaN(givenAt.getTime())) return false;
  if (givenAt.getTime() > now.getTime() + GIVEN_AT_FUTURE_SKEW_MS) return false;
  const diff = daysBetweenDateStr(todayStr, dateStrInTz(tz, givenAt));
  return diff != null && Math.abs(diff) <= DOSE_LOG_DATE_WINDOW_DAYS;
}

// The given_at stamp for a dose confirm that was CAPTURED on the client and replayed
// later (the offline write queue, #1427). The queued tap carries the moment the user
// actually took the dose; the log should say so rather than claiming the replay
// instant. But the client clock is untrusted — a phone hours ahead, or a stamp that
// doesn't even fall on the day the log is being attributed to, would write a
// self-contradicting row (a given_at whose profile-local date isn't the row's own
// `date`, which is exactly what the adherence reads render against).
//
// So: VALIDATE, never drop. Returns the instant to stamp when it is usable, or NULL
// meaning "fall back to the server's own now" — losing the precise minute is a
// cosmetic loss, refusing the confirm would be a lost medication log. Two rules:
//   • not meaningfully in the future (the same GIVEN_AT_FUTURE_SKEW_MS tolerance the
//     PRN retro-entry guard uses), and
//   • its profile-local date IS `date`, the day the log row is attributed to.
// The second rule is what ties the adherence day/slot attribution to the captured
// timestamp: an accepted stamp always sits inside its own log day. `date` itself is
// separately gated by isDoseDateAccepted in the write core.
//
// `now` is the REAL current instant (a clock-skew comparison between two wall clocks,
// not a date derivation — deliberately outside the #990 test-clock seam) and is
// injected so this is fully deterministic in a unit test.
export function resolveQueuedTakenAt(
  takenAt: Date | null | undefined,
  tz: string,
  date: string,
  now: Date
): Date | null {
  if (!takenAt || Number.isNaN(takenAt.getTime())) return null;
  if (takenAt.getTime() > now.getTime() + GIVEN_AT_FUTURE_SKEW_MS) return null;
  return dateStrInTz(tz, takenAt) === date ? takenAt : null;
}

// Explicit history entry has a different trust boundary from a stale reminder tap:
// the authenticated user deliberately chooses the date in the medication record,
// and the write core separately requires scheduled doses to fall inside a medication
// course. A PRN dose may move the applicable course start backward because the dose
// itself establishes use by that date. It may therefore reach any distance into the
// past; the detail page supplies the deliberate-entry UI and the write core enforces
// medication-course boundaries. A historical dose still cannot be created in the
// future.
export function isHistoricalDoseTimeAccepted(
  tz: string,
  todayStr: string,
  givenAt: Date,
  now: Date = new Date()
): boolean {
  if (Number.isNaN(givenAt.getTime())) return false;
  if (givenAt.getTime() > now.getTime() + GIVEN_AT_FUTURE_SKEW_MS) return false;
  const diff = daysBetweenDateStr(todayStr, dateStrInTz(tz, givenAt));
  return diff != null && diff <= 0;
}
