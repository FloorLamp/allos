// The CALENDAR half of intake dueness (issue #1602) — pure date rules, no DB.
//
// `condition` (lib/intake-schedule.ts) answers "is this the item's KIND of day?"
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

// The dueness-relevant shape of ONE dose schedule, independent of when it applied:
// the slot it occupies plus its own calendar. This is what a version RECORDS and what
// `doseOnDay` evaluates — deliberately narrower than the dose row, which also carries
// amount, food timing, sort and provenance. Those are cosmetic to dueness: changing an
// amount cannot make a day due or not due, so it must never move an adherence boundary
// (#1973).
export interface DoseSchedule {
  time_of_day?: string | null;
  weekdays?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

// ONE version of a dose's schedule (issue #1973, migration 151): the schedule fields
// above plus the calendar day they took effect. Versions are HALF-OPEN and closed by
// the next one — there is no `effective_to` — so a change is a single append and
// "no gaps, no overlaps" is structural rather than an invariant two rows have to keep
// agreeing about.
export interface DoseScheduleVersion extends DoseSchedule {
  // Profile-LOCAL calendar day (YYYY-MM-DD), inclusive.
  effective_from: string;
}

// The per-dose calendar fields: an optional weekday subset and an optional inclusive
// validity window. NULL at any position means "no opinion" — the dose lands on every
// one of the item's on-days, forever.
//
// `versions` is the dose's effective-dated schedule HISTORY (#1973), attached by the
// query layer. It is optional, and its absence is not a gap: a dose with no recorded
// history reads as "this row, always", which is byte-for-byte the pre-#1973 behaviour
// and is exactly what the seeded version says. Every literal, fixture and seed row that
// never grew a history therefore keeps its exact current dueness.
export interface DoseCadence extends DoseSchedule {
  versions?: readonly DoseScheduleVersion[] | null;
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

// ---- Effective-dated schedules (issue #1973) -------------------------------

// The schedule in force on `dateISO` — the version with the LATEST `effective_from`
// that is not after the day being judged.
//
// Two fallbacks, both deliberate:
//
//   • NO HISTORY AT ALL → the live row. A dose whose versions were never recorded
//     (a fixture, a seed, an importer insert) reads exactly as it did before #1973.
//
//   • A DAY BEFORE THE FIRST VERSION → the EARLIEST version, not "no schedule". This
//     is the one place the resolver could be tempted to answer "the dose did not exist
//     yet", and it must not: EXISTENCE is a different question with a different, better
//     answer already (doseWindowSince — timezone-aware and widened by logged history,
//     because a log is proof the dose existed on its date, #1442). Answering it here
//     from a UTC-sliced creation stamp would silently override that bound and blank
//     days a person really did take, which is the #1972 failure in the other direction.
//     The oldest recorded rule is simply the best statement we have about a day before
//     recording began — and for a dose with the single seeded version, that IS the
//     pre-#1973 behaviour.
//
// Pure string-date math (YYYY-MM-DD sorts chronologically), so it is client-safe and the
// page, the reminder and the adherence denominator all resolve a day identically (#221).
export function doseScheduleAsOf(
  dose: DoseCadence,
  dateISO: string
): DoseSchedule {
  const versions = dose.versions;
  if (!versions || versions.length === 0) return dose;
  let best: DoseScheduleVersion | null = null;
  let earliest: DoseScheduleVersion | null = null;
  for (const v of versions) {
    if (earliest == null || v.effective_from < earliest.effective_from) {
      earliest = v;
    }
    if (v.effective_from > dateISO) continue;
    // `>=` so that when two versions share a day (two edits, one calendar day) the LAST
    // one in the array wins — the query orders by (effective_from, id), so that is the
    // day's final state. The write path additionally upserts on (dose_id,
    // effective_from), so this is belt-and-braces rather than the primary defence.
    if (best == null || v.effective_from >= best.effective_from) best = v;
  }
  return best ?? earliest ?? dose;
}

// The day a dose's schedule is KNOWN to have changed without the change having been
// recorded — a legacy `updated_at` stamp newer than the newest version we hold.
//
// This is the honest treatment of data that predates #1973. `updated_at` is bumped only
// when a dose's slot changes, so it says "the schedule changed on this day" — but it
// does not say what the schedule WAS, and nothing can reconstruct that. Migration 151
// seeds one version per dose from its CURRENT row, so an already-re-timed dose comes out
// of the migration with a single version whose fields describe the post-edit slot only.
//
// Judging the pre-edit days by that version would be exactly the retroactive
// re-judgment the invariant forbids — the engine would re-accuse someone of missing a
// morning dose on weeks it was an evening dose (#430, the harm the old clamp existed to
// prevent). So for those days, and only those, the conservative clamp stays: we decline
// to infer rather than infer wrongly.
//
// It self-heals. The write path records a dose's pre-edit schedule before appending the
// new version, so the FIRST schedule edit after this ships gives the dose a real history
// and this function goes quiet for it forever after. Returns null for every dose whose
// history is recorded — which is every dose created or edited from now on.
export function unrecordedScheduleChangeOn(
  dose: DoseCadence & { updated_at?: string | null }
): string | null {
  const changedOn = dose.updated_at ? dose.updated_at.slice(0, 10) : null;
  if (!changedOn) return null;
  const versions = dose.versions;
  if (!versions || versions.length === 0) return changedOn;
  const newest = versions.reduce((a, v) =>
    v.effective_from >= a.effective_from ? v : a
  );
  // A version at or after the stamp IS the record of that change.
  return newest.effective_from >= changedOn ? null : changedOn;
}

// Whether two schedules differ in a DUENESS-RELEVANT way — the write path's test for
// "does this edit deserve a new version?". Cosmetic fields (amount, food timing, sort,
// notes) are absent from DoseSchedule by construction, so a typo fix in an amount can
// never reach this and can never move an adherence boundary (#1973).
export function doseScheduleDiffers(a: DoseSchedule, b: DoseSchedule): boolean {
  return (
    (a.time_of_day ?? null) !== (b.time_of_day ?? null) ||
    (a.weekdays ?? null) !== (b.weekdays ?? null) ||
    (a.start_date ?? null) !== (b.start_date ?? null) ||
    (a.end_date ?? null) !== (b.end_date ?? null)
  );
}

// Whether THIS DOSE ROW lands on `dateISO`, given its own weekday subset and validity
// window. Independent of the item's cadence — both are ANDed by the caller — so a
// weekly item can still split its dose rows, and a taper window can expire under any
// cadence.
//
// The rules come from the version IN FORCE ON `dateISO` (#1973), not from the current
// row: a dose narrowed to Mondays today was not a Mondays-only dose last month, and
// judging last month by today's rule would retroactively invent (or forgive) misses.
// That resolution belongs HERE rather than in each caller precisely because this
// function already receives the day being judged — every surface that iterates dose
// rows inherits effective-dating for free, exactly as it inherited the calendar.
//
// A window that has ENDED is not a retire (#1602): the row stops being due and its
// adherence history reads exactly as it did, which is what lets a taper be expressed as
// four windowed rows instead of four destructive amount edits.
export function doseOnDay(dose: DoseCadence, dateISO: string): boolean {
  const schedule = doseScheduleAsOf(dose, dateISO);
  const days = parseWeekdays(schedule.weekdays);
  if (days.size > 0 && !days.has(weekdayOfDateStr(dateISO))) return false;
  // String comparison is correct and cheapest for YYYY-MM-DD (lexicographic ==
  // chronological), and it is how every other stored-date window in this codebase is
  // compared. Both bounds are INCLUSIVE.
  if (isRealIsoDate(schedule.start_date) && dateISO < schedule.start_date) {
    return false;
  }
  if (isRealIsoDate(schedule.end_date) && dateISO > schedule.end_date) {
    return false;
  }
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
