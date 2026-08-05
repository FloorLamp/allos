// Pure acceptance windows for dose/administration timestamps — no DB/network, so
// unit-tested in lib/__tests__. Shared by the scheduled-dose date guard
// (isDoseDateAccepted) and the PRN given_at guard (#614 extended to #797's
// user-suppliable intake time).

import { daysBetweenDateStr, dateStrInTz } from "./date";

// A late/retro dose-log DATE is accepted only within a small window of the profile's
// today (#614): a forged/far-off date can't land a misdated row, but a legitimate
// late/after-midnight tap within the window still logs to the reminder's own day.
//
// COUPLED TO `MESSAGE_POINTER_RETENTION_DAYS` (lib/notifications/message-pointers.ts,
// currently 3). Since #2018 a Telegram dose keyboard stays live for exactly this window,
// and the reconcile sweep can only close it while its pointer still exists. Raising this
// past retention would strand live keyboards permanently — nothing left to close them
// with — so the two move together, window < retention.
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

// WHICH CLOCK `now` MUST BE (issue #2031). The two guards below take it as a REQUIRED
// argument — deliberately, with no `new Date()` default — because picking the wrong
// clock is silent and only fails for ~30 minutes a day.
//
// Both guards compare a given_at against `now` AND its profile-local date against
// `todayStr`, and `todayStr` always comes from `today()`, i.e. from the app's clock
// seam (lib/clock.ts). So `now` must come from that SAME seam: a guard whose two
// halves read two different clocks is not one predicate, it is two, and the caller
// gets to find out which one disagreed. Concretely, the timestamp being validated is
// itself app-clock-derived — the amend form prefills the log's stored given_at, which
// `sqlNow()` (#1534) wrote from the seam — so judging it against the real wall clock
// asks whether the app's own "now" is in the future, which inside #1464's forward
// nudge is exactly what it is.
//
// This does NOT weaken #797's forgery rule. `now()` returns real time whenever
// ALLOS_TEST_NOW is unset, which is always in production (it is a test hook, absent
// from .env.example, and boot-tasks warns loudly if an instance sets it) — so the
// production comparison is byte-identical to `new Date()`. What changes is only that
// a frozen-clock e2e run judges a frozen-clock timestamp on the frozen clock.
//
// The counter-example is `resolveQueuedTakenAt` below, which keeps REAL time on
// purpose: its input came off an untrusted CLIENT wall clock, so the comparison is
// genuinely between two independent real clocks rather than inside the app's own
// calendar frame.

// Whether a supplied given_at instant is acceptable, given the profile timezone, its
// today (YYYY-MM-DD), and "now": not in the future past the skew, and its profile-
// local date within DOSE_LOG_DATE_WINDOW_DAYS of today (so a same-day or recent retro
// time lands, a far-off/forged one doesn't). Pure — `now` is injected (see the clock
// note above) so it's fully deterministic in a unit test.
export function isGivenAtAccepted(
  tz: string,
  todayStr: string,
  givenAt: Date,
  now: Date
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
// future. `now` is required and must be the app clock — see the clock note above
// isGivenAtAccepted.
export function isHistoricalDoseTimeAccepted(
  tz: string,
  todayStr: string,
  givenAt: Date,
  now: Date
): boolean {
  if (Number.isNaN(givenAt.getTime())) return false;
  if (givenAt.getTime() > now.getTime() + GIVEN_AT_FUTURE_SKEW_MS) return false;
  const diff = daysBetweenDateStr(todayStr, dateStrInTz(tz, givenAt));
  return diff != null && diff <= 0;
}
