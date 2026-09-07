// Pure formatters for PRN (as-needed) administrations (#797) — no DB/network, so
// unit-tested in lib/__tests__. Shared by the medications card / dashboard presentation
// (the "2 today · last 4:02pm" line) and the Telegram /dose tap toast, so every
// surface renders one administration the same way ("one question, one computation").

import type { AdministrationOutcome } from "./types";
import { parseUtcSql, zonedDateParts } from "./date";
import {
  formatClock,
  formatCompactRelativeTime,
  type TimeFormat,
} from "./format-date";
import { GLYPH } from "./notifications/glyphs";
import { formatRecordDate } from "./record-format";

// Render a stored UTC administration time ("YYYY-MM-DD HH:MM:SS") as a profile-local
// clock ("4:02pm") for the "last …" line. Empty string on a missing/garbage value so
// a caller can COALESCE it away. Pref-aware (#964): `timeFormat` picks the login's
// 12h/24h clock. It DEFAULTS to "12h" — the status quo — because a login-less caller
// (the Telegram /dose tap toast) has a profile but no login pref in context and keeps
// the fixed 12h format; page/widget callers pass the login's resolved timeFormat.
export function formatGivenAtClock(
  tz: string,
  stored: string | null | undefined,
  timeFormat: TimeFormat = "12h"
): string {
  const d = parseUtcSql(stored);
  if (!d) return "";
  const { hhmm } = zonedDateParts(tz, d);
  const [hStr, m] = hhmm.split(":");
  return formatClock(timeFormat, Number(hStr), Number(m), "lower-nospace");
}

// NAME THE DAY A CLOCK BELONGS TO, when nothing beside it does. An administration may
// legitimately be on another local day (a redose notice crossing midnight, a cockpit
// panel whose last dose was last night), and a bare `(10:41am)` then looks like it
// happened this morning. Takes the already-rendered clock so each caller keeps its own
// clock convention — the notice's plain one, the panel's relative-aged one — and there
// is still ONE spelling of the date half.
export function withGivenAtDay(
  tz: string,
  stored: string | null | undefined,
  referenceDate: string,
  clock: string
): string {
  const d = parseUtcSql(stored);
  if (!d || !clock) return clock;
  const localDate = zonedDateParts(tz, d).date;
  return localDate === referenceDate
    ? clock
    : `${formatRecordDate(localDate)} at ${clock}`;
}

// The redose notice's arming time.
export function formatGivenAtNoticeTime(
  tz: string,
  stored: string | null | undefined,
  referenceDate: string
): string {
  return withGivenAtDay(
    tz,
    stored,
    referenceDate,
    formatGivenAtClock(tz, stored)
  );
}

// A displayed administration that landed on the profile's current local day keeps
// its exact clock while adding elapsed context: "4:02pm (2 hrs ago)". Older times
// stay as plain clocks because their neighboring date already supplies the useful
// context. `now` is injectable so server-rendered and frozen-clock e2e surfaces use
// the same instant rather than drifting at hydration.
export function formatGivenAtClockWithRelativeAge(
  tz: string,
  stored: string | null | undefined,
  timeFormat: TimeFormat = "12h",
  now: Date = new Date()
): string {
  const d = parseUtcSql(stored);
  if (!d) return "";
  const clock = formatGivenAtClock(tz, stored, timeFormat);
  if (zonedDateParts(tz, d).date !== zonedDateParts(tz, now).date) {
    return clock;
  }
  return `${clock} (${formatCompactRelativeTime(d.toISOString(), now)})`;
}

// The med card / widget subtitle for a PRN med's day: "2 today · last 4:02pm", or
// "None today" when nothing has been logged. `count` is today's administrations and
// `lastClock` the formatGivenAtClock of the latest (empty when count is 0). Pure.
export function administrationDayLabel(
  count: number,
  lastClock: string
): string {
  if (count <= 0) return "None today";
  const n = `${count} today`;
  return lastClock ? `${n} · last ${lastClock}` : n;
}

// When a neighboring redose line already owns the 24h count ("1 of 4 in 24h"),
// keep this line focused on the other useful fact instead of repeating "1 today".
//
// IT CANNOT ASK FOR A DAY IT DOES NOT RENDER (#5488 fix 3). It used to take the
// profile-local DAY's count and answer "None today" on a zero — under an eyebrow that
// had just said the same word, and discarding `lastClock`, the one fact the function
// exists to carry. `lastGivenAt` has no date bound, so at 6 a.m. after an overnight
// dose the panel led with the least useful of its two answers. A signature that cannot
// express the wrong question is the cheapest guard there is (#4724's class): the last
// dose, or the honest absence of one, and no day word in either arm.
export function administrationLastDoseLabel(lastClock: string): string {
  return lastClock ? `Last dose ${lastClock}` : "No doses logged";
}

// Human summary of a PRN administration attempt, shared by the dashboard quick-log
// action and the Telegram /dose tap so both answer identically. `name` names the med.
export function administrationOutcomeText(
  outcome: AdministrationOutcome,
  name: string
): string {
  switch (outcome.kind) {
    case "logged":
      return outcome.count > 1
        ? `Logged ${GLYPH.done} ${name} — ${outcome.count} today`
        : `Logged ${GLYPH.done} ${name}`;
    case "duplicate":
      return `Already logged ${name} moments ago — not counting it twice.`;
    case "invalid-time":
      return "Not logged — that time is out of range. Pick a time today.";
    case "inactive":
      return `Not logged — ${name} is paused. Resume it in the app.`;
    case "stale-item":
    default:
      return "Not logged — that med is out of date. Open the app.";
  }
}

// True when the attempt actually recorded (or idempotently matched) an intake — the
// outcomes a success acknowledgement is honest for (the markDoseTaken contract).
export function administrationLogged(outcome: AdministrationOutcome): boolean {
  return outcome.kind === "logged" || outcome.kind === "duplicate";
}
