// Pure acceptance windows for dose/administration timestamps — no DB/network, so
// unit-tested in lib/__tests__. Shared by the scheduled-dose date guard
// (isDoseDateAccepted) and the PRN given_at guard (#614 extended to #797's
// user-suppliable intake time).

import { daysBetweenDateStr, dateStrInTz } from "./date";

// A late/retro dose-log DATE is accepted only within a small window of the profile's
// today (#614): a forged/far-off date can't land a misdated row, but a legitimate
// late/after-midnight tap within the window still logs to the reminder's own day.
export const DOSE_LOG_DATE_WINDOW_DAYS = 2;

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
