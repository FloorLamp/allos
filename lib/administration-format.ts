// Pure formatters for PRN (as-needed) administrations (#797) — no DB/network, so
// unit-tested in lib/__tests__. Shared by the medications card / dashboard widget
// (the "2 today · last 4:02pm" line) and the Telegram /dose tap toast, so every
// surface renders one administration the same way ("one question, one computation").

import type { AdministrationOutcome } from "./types";
import { parseUtcSql, zonedDateParts } from "./date";

// Render a stored UTC administration time ("YYYY-MM-DD HH:MM:SS") as a profile-local
// 12-hour clock ("4:02pm") for the "last …" line. Empty string on a missing/garbage
// value so a caller can COALESCE it away.
export function formatGivenAtClock(
  tz: string,
  stored: string | null | undefined
): string {
  const d = parseUtcSql(stored);
  if (!d) return "";
  const { hhmm } = zonedDateParts(tz, d);
  const [hStr, m] = hhmm.split(":");
  let h = Number(hStr);
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m}${ap}`;
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

// Human summary of a PRN administration attempt, shared by the dashboard quick-log
// action and the Telegram /dose tap so both answer identically. `name` names the med.
export function administrationOutcomeText(
  outcome: AdministrationOutcome,
  name: string
): string {
  switch (outcome.kind) {
    case "logged":
      return outcome.count > 1
        ? `Logged ✅ ${name} — ${outcome.count} today`
        : `Logged ✅ ${name}`;
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
