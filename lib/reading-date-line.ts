import { formatCompactAge } from "./format-date";
import { isBiomarkerStale } from "./reference-range";

// ONE line for "when was this reading taken?" (issue #2316).
//
// The biomarker row used to spend THREE stacked lines on that question: the ISO
// date, the same fact re-notated as "2 months ago", and a "Source document" link
// that is provenance navigation rather than a date at all. On a phone those three
// lines are ~40% of a card, and two of them say the same thing.
//
// So the date is one line — `2026-06-03 · 2mo` — at BOTH viewports, from one
// authored tree (no `sm:` branch; the wide table's Date column reads better as one
// line too). The compact half is the SHARED formatter (#1216's `formatCompactAge`),
// not a second one, so the dashboard's recent-labs widget and this row can never
// round the same date into different buckets. The link moved into the row's ⋯ menu.
//
// The over-a-year amber treatment travels with the AGE token, because the age is
// what went stale — the date itself is just a fact. Staleness is not re-derived
// here: it is `isBiomarkerStale`, the biomarker adapter over lib/freshness, so a
// category that carries no retest clock (vitals, reference, genomics …) never goes
// amber on this row either.
//
// Pure and React-free, so the composition is unit-tested rather than eyeballed.

// The visible separator between the two tokens. Exported so the component and its
// test name the same string instead of two copies that can drift apart.
export const DATE_AGE_SEPARATOR = " · ";

// The hover text on a stale age token — the same sentence the cell carried before
// the two lines became one.
export const STALE_AGE_TITLE = "Over a year old — consider retesting";

const AGE_CLASS_CURRENT = "text-slate-500 dark:text-slate-400";
const AGE_CLASS_STALE = "text-amber-600 dark:text-amber-400";

export interface ReadingDateLine {
  /** The reading's own day, printed as stored. */
  date: string;
  /** The compact age beside it, or null when this row shows no age. */
  age: string | null;
  /** Past its retest window — the amber treatment and title belong on `age`. */
  stale: boolean;
  /** Hover text for the age token; null unless stale. */
  ageTitle: string | null;
  /** The class the age token wears. Amber only when the age is the stale one. */
  ageClassName: string;
}

// `showAge` is the caller's "is this the analyte's CURRENT reading?" verdict: an
// older reading in the same run prints its date alone, because "how long ago" is a
// question about where the analyte stands today, not about every draw ever taken.
export function readingDateLine(
  reading: { date: string; category: string | null },
  today: string,
  showAge: boolean
): ReadingDateLine {
  if (!showAge)
    return {
      date: reading.date,
      age: null,
      stale: false,
      ageTitle: null,
      ageClassName: AGE_CLASS_CURRENT,
    };
  const stale = isBiomarkerStale(reading.date, reading.category, today);
  return {
    date: reading.date,
    age: formatCompactAge(reading.date, today),
    stale,
    ageTitle: stale ? STALE_AGE_TITLE : null,
    ageClassName: stale ? AGE_CLASS_STALE : AGE_CLASS_CURRENT,
  };
}
