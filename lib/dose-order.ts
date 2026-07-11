// Shared "dose day" ordering (issue #297). ONE pure comparator for the order a
// day's due doses read in, so /medicine's due-today section and the Upcoming /
// needs-attention surfaces answer "what does my dose day look like?" the same
// way (the AGENTS.md one-question-one-computation rule, ordering edition).
//
// The order is: time bucket (Morning → Midday → Evening → Before sleep →
// Anytime) → priority (mandatory → high → low) → stack (clusters stack members;
// unstacked last) → name. It reuses timeBucket + PRIORITY_ORDER from the
// schedule engine rather than re-deriving either.
//
// Two entry points share a single source of truth: doseSortKey() renders a
// lexically-sortable key string, and compareDoseDay() is that key compared. The
// key doubles as UpcomingItem.sortHint, so the Upcoming banding/attention layers
// reproduce this exact order with a plain string compare (see compareSortHint).

import type { SupplementPriority } from "./types";
import {
  timeBucket,
  TIME_BUCKETS,
  PRIORITY_ORDER,
} from "./supplement-schedule";

// The minimal shape the ordering needs — satisfied by /medicine's { supplement,
// dose } Item and by the Upcoming dose adapter alike.
export interface DoseDayEntry {
  timeOfDay: string | null;
  priority: SupplementPriority;
  stack: string | null;
  name: string;
}

// Rank of a free-text time_of_day within the day, via the shared bucketer.
function bucketRank(timeOfDay: string | null): number {
  return TIME_BUCKETS.indexOf(timeBucket(timeOfDay));
}

// Field separator for the key: 0x1F (unit separator) sorts below every printable
// character, so a shorter/earlier text field wins the compare (correct lexical
// order) and the numeric prefixes never bleed into the text fields.
const SEP = "\u001f";

// A lexically-sortable key encoding bucket → priority → stack → name. Bucket and
// priority ranks are single digits (0–4, 0–2), so a fixed-width numeric prefix
// keeps field boundaries aligned; an unstacked item sorts after stacked ones
// (matching /medicine's `stack ?? "~"`). Used directly as UpcomingItem.sortHint.
export function doseSortKey(entry: DoseDayEntry): string {
  const bucket = bucketRank(entry.timeOfDay);
  const priority = PRIORITY_ORDER[entry.priority];
  const stack = entry.stack ?? "~";
  return `${bucket}${priority}${SEP}${stack}${SEP}${entry.name}`;
}

// Plain code-unit string compare (NOT localeCompare, which treats the 0x1F
// separator as ignorable and would collapse the field boundaries). Shared by the
// Upcoming/attention tiebreaks so their sortHint ordering matches doseSortKey.
export function compareSortHint(
  a: string | undefined,
  b: string | undefined
): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

// The dose-day comparator, defined AS its sort key so the two can never drift.
export function compareDoseDay(a: DoseDayEntry, b: DoseDayEntry): number {
  return compareSortHint(doseSortKey(a), doseSortKey(b));
}
