// The CALENDAR half of intake dueness (issue #1602) — pure date rules, no DB.
//
// `condition` (lib/supplement-schedule.ts) answers "is this the item's KIND of day?"
// (workout / rest / situational / held). This module answers the orthogonal question
// "is today one of this item's DAYS AT ALL?" — weekly, every-N-days, per-dose weekday
// splits, and per-dose validity windows. The two are ANDed into the same gate rather
// than being a second engine, so every surface that already reads dueness (Upcoming,
// the hero, the digest, reminders, escalation, adherence denominators) inherits the
// cadence for free under the one-computation rule (#221).
//
// Cadence NEVER invents obligation. It can only ever say "not today" about an item the
// user already declared something about; it cannot make a `may` item due, and it cannot
// raise or lower what is owed on a day it does apply to. That is the whole reason it
// composes as a conjunct: an AND can subtract days, never add expectation.
//
// Weekday indices are the repo's existing 0=Sun … 6=Sat convention (lib/date.ts
// `weekdayOfDateStr`, WEEKDAYS_SHORT, weekdayOrder, startOfWeekStr), NOT ISO 1=Mon.
// One numbering, one meaning, everywhere.

import {
  WEEKDAYS_SHORT,
  daysBetweenDateStr,
  isRealIsoDate,
  weekdayOfDateStr,
} from "./date";

// The item-level calendar rule.
//   daily     every day the condition allows (the default; pre-#1602 behaviour)
//   weekly    only on `cadence_weekdays`
//   interval  every `cadence_interval_days` days counting from `cadence_anchor_date`
export type CadenceKind = "daily" | "weekly" | "interval";

export const CADENCE_KINDS: CadenceKind[] = ["daily", "weekly", "interval"];

export const CADENCE_KIND_LABELS: Record<CadenceKind, string> = {
  daily: "Every day",
  weekly: "Specific days of the week",
  interval: "Every N days",
};

// The cadence fields as they live on an intake item. Every field is optional here so a
// caller holding a partial row (a test literal, a projection) still type-checks and
// simply reads as `daily` — the same value migration 126 defaults existing rows to.
export interface ItemCadence {
  cadence_kind?: CadenceKind | null;
  cadence_weekdays?: string | null;
  cadence_interval_days?: number | null;
  cadence_anchor_date?: string | null;
}

// The per-dose calendar fields: an optional weekday subset and an optional inclusive
// validity window. NULL at any position means "no opinion" — the dose lands on every
// one of the item's on-days, forever.
export interface DoseCadence {
  weekdays?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

// Parse a stored weekday CSV ("0,3,5") into a set of 0..6 indices. Deliberately
// TOTAL and forgiving on read: unparseable junk, out-of-range numbers and duplicates
// are dropped rather than thrown on, because this runs inside a dueness check on a
// safety path — a corrupt string must degrade to "no weekday restriction" (see
// callers, which treat an EMPTY set as "unset"), never crash a reminder tick.
// Validation belongs at the write boundary (`normalizeWeekdays`), not here.
export function parseWeekdays(csv: string | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!csv) return out;
  for (const part of csv.split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 0 && n <= 6) out.add(n);
  }
  return out;
}

// The write-boundary inverse: a canonical, de-duplicated, ascending CSV, or null when
// nothing valid remains. Canonical ordering means two equivalent user selections store
// identically, so a no-op edit never looks like a change.
export function normalizeWeekdays(
  days: readonly number[] | null | undefined
): string | null {
  if (!days) return null;
  const set = new Set<number>();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d);
  }
  if (set.size === 0) return null;
  return [...set].sort((a, b) => a - b).join(",");
}

// Whether the ITEM's calendar rule puts `dateISO` on its schedule.
//
// Every branch FAILS OPEN to `true` when its own configuration is missing or unusable
// (weekly with no weekdays, interval with no/absurd interval or no anchor). That
// direction is deliberate and is the safety-critical decision in this file: an item
// whose cadence is half-configured must keep behaving like the daily item it was
// before, because the alternative — silently never being due — is a medication that
// stops reminding without telling anyone. Failing open reminds too often, which is
// visible and correctable; failing closed is a silent blackout.
export function cadenceOn(item: ItemCadence, dateISO: string): boolean {
  const kind = item.cadence_kind ?? "daily";
  if (kind === "weekly") {
    const days = parseWeekdays(item.cadence_weekdays);
    if (days.size === 0) return true;
    return days.has(weekdayOfDateStr(dateISO));
  }
  if (kind === "interval") {
    const n = item.cadence_interval_days;
    const anchor = item.cadence_anchor_date;
    if (!n || !Number.isInteger(n) || n < 1) return true;
    if (n === 1) return true;
    if (!isRealIsoDate(anchor)) return true;
    const delta = daysBetweenDateStr(anchor, dateISO);
    if (delta == null) return true;
    // BEFORE the anchor the item has not started: an every-3-days patch anchored on
    // the 10th is not retroactively due on the 7th. (A negative delta divisible by the
    // interval would otherwise read as an on-day.)
    if (delta < 0) return false;
    return delta % n === 0;
  }
  return true;
}

// Whether THIS DOSE ROW lands on `dateISO`, given its own weekday subset and validity
// window. Independent of the item's cadence — both are ANDed by the caller — so a
// weekly item can still split its dose rows, and a taper window can expire under any
// cadence.
//
// A window that has ENDED is not a retire (#1602): the row stops being due and its
// adherence history reads exactly as it did, which is what lets a taper be expressed as
// four windowed rows instead of four destructive amount edits.
export function doseOnDay(dose: DoseCadence, dateISO: string): boolean {
  const days = parseWeekdays(dose.weekdays);
  if (days.size > 0 && !days.has(weekdayOfDateStr(dateISO))) return false;
  // String comparison is correct and cheapest for YYYY-MM-DD (lexicographic ==
  // chronological), and it is how every other stored-date window in this codebase is
  // compared. Both bounds are INCLUSIVE.
  if (isRealIsoDate(dose.start_date) && dateISO < dose.start_date) return false;
  if (isRealIsoDate(dose.end_date) && dateISO > dose.end_date) return false;
  return true;
}

// ---- Density (for consumption/refill projection) ---------------------------

// The fraction of days this item's cadence actually lands on: 1 for daily, 3/7 for a
// Mon/Wed/Fri weekly, 1/3 for every-3-days. Refill's "≈N days of supply" divides the
// schedule-based dose rate by this, so 12 tablets of a weekly med read as ≈12 WEEKS of
// supply instead of ≈12 days (which would nag for a refill every single week).
//
// Only the SCHEDULE fallback needs this: the history-based rate already observes the
// real cadence in the taken log. Never returns 0 — a fail-open cadence is daily.
export function cadenceDensity(item: ItemCadence): number {
  const kind = item.cadence_kind ?? "daily";
  if (kind === "weekly") {
    const days = parseWeekdays(item.cadence_weekdays);
    return days.size === 0 ? 1 : days.size / 7;
  }
  if (kind === "interval") {
    const n = item.cadence_interval_days;
    if (!n || !Number.isInteger(n) || n < 1) return 1;
    return 1 / n;
  }
  return 1;
}

// ---- Labels ----------------------------------------------------------------

// A short human cadence phrase ("Mondays", "Mon/Thu", "Every 3 days"), or null for a
// plain daily item (which needs no qualifier — saying "daily" everywhere is noise).
// ONE formatter so the dose row, the Upcoming due-text, the digest and the reminder all
// name a cadence identically (#221).
export function cadenceLabel(item: ItemCadence): string | null {
  const kind = item.cadence_kind ?? "daily";
  if (kind === "weekly") {
    const days = [...parseWeekdays(item.cadence_weekdays)].sort(
      (a, b) => a - b
    );
    if (days.length === 0 || days.length === 7) return null;
    if (days.length === 1) return `${WEEKDAYS_SHORT[days[0]]}days`;
    return days.map((d) => WEEKDAYS_SHORT[d]).join("/");
  }
  if (kind === "interval") {
    const n = item.cadence_interval_days;
    if (!n || !Number.isInteger(n) || n < 1 || n === 1) return null;
    return n === 2 ? "Every other day" : `Every ${n} days`;
  }
  return null;
}

// The per-dose qualifier ("Mon/Wed/Fri", "until Mar 3", "from Mar 4 to Mar 10"), or
// null when the row has no calendar opinion of its own. This is what makes an
// alternating-amount pair legible as two rows rather than two mystery duplicates —
// the label must carry the attribute that actually distinguishes them.
export function doseCadenceLabel(dose: DoseCadence): string | null {
  const parts: string[] = [];
  const days = [...parseWeekdays(dose.weekdays)].sort((a, b) => a - b);
  if (days.length > 0 && days.length < 7) {
    parts.push(days.map((d) => WEEKDAYS_SHORT[d]).join("/"));
  }
  const start = isRealIsoDate(dose.start_date) ? dose.start_date : null;
  const end = isRealIsoDate(dose.end_date) ? dose.end_date : null;
  if (start && end) parts.push(`${start} to ${end}`);
  else if (start) parts.push(`from ${start}`);
  else if (end) parts.push(`until ${end}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// Whether an item carries any non-daily calendar rule at all — the cheap predicate the
// UI uses to decide whether to show a cadence chip, and the reason a plain daily item's
// rendering is untouched by this feature.
export function hasCadence(item: ItemCadence): boolean {
  return cadenceLabel(item) != null;
}
