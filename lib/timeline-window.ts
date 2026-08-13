// TIMELINE WINDOWING (issue #2657) — PURE, no DB and no JSX.
//
// `/timeline` at its default "All · All dates" was the tallest page in the app by an
// order of magnitude: 47,251px at 390px on the seeded profile, 3.2 MB of HTML, 87 day
// groups, because every event the gather returned rendered as its own card and the
// feed OPENED on far-future goal target dates — the reader's entry point was
// speculative scheduling, not their own recent history.
//
// This module is the presentation decision that fixes it, and it is ONLY a
// presentation decision: day attribution, event identity and ordering are untouched
// (the caller still hands us `groupTimelineDays`' newest-first day groups), nothing is
// dropped, and every event stays reachable. Three bands, in reading order:
//
//   1. AHEAD — everything dated after the subject's today folds into one line at the
//      top. Never the opening content, never open by default.
//   2. RECENT — the last TIMELINE_RECENT_DAYS days render exactly as they always have:
//      day groups, individual event cards. This is the reader's entry point.
//   3. MONTHS — older days group by CALENDAR MONTH, one collapsed card each, expanding
//      in place. Calendar months rather than fixed 30-day windows because they carry
//      names people remember ("March — when I was sick"); a 30-day window's label is a
//      range nobody thinks in. 14 days rather than "this month" because "this month"
//      is 1–31 days depending on the date and nearly empties on the 1st, landing the
//      reader straight on summary cards.
//   4. YEARS — a month OUTSIDE the current calendar year compresses once more, into a
//      year card ("2025 · 180 events · 3 months"). The same grammar one level up, and
//      the reason is the same defect one level up: a month card costs ~70px, so a
//      profile deep enough to need windowing at all grows a spine of them. On the
//      seeded profile at 390px, `?category=medical` carried EIGHTEEN collapsed month
//      cards — 3,723px standing in for 5 rendered days — which is the unrolled-history
//      shape again, only in miniature. Seven cards and 2,799px with years. Count them
//      as `[data-fold-key]` nodes, which is one per card: the `timeline-fold-` TESTID
//      prefix matches three nodes per card (section, toggle, counts) and answers 54,
//      which is how this comment first shipped the wrong number. With years, a
//      five-year profile is a one-screen spine: future fold, recent days, this year's
//      months, then one card per earlier year.
//
// A YEAR IS OPEN WHENEVER A MONTH INSIDE IT IS. Nesting could have needed two keys in
// the URL to reach one March, which would have made every pre-existing `?open=2025-03`
// link a link to nothing the moment years shipped. Instead the year's open state is
// DERIVED — `open.has("2025") || any month of 2025 is open` — so one month key still
// addresses one month, `foldKeyHiding` still answers with a single key, and the
// deep-link contract ("expand its month on arrival") holds without the caller knowing
// years exist. The cost is that CLOSING a year has to close its months too, or the
// derivation would immediately re-open it; that is `toggledTimelineOpen`'s
// `descendants` argument, and it is the only place the nesting is visible.
//
// WHAT THE FOLD LINE MAY SAY. Counts, and only counts — "47 events · 22 days" (the
// #1504 always-present-count grammar). A month card that speaks RECAP language
// ("12 workouts · 2 PRs · adherence 91%") is the decided destination but is a
// different computation with a different cost: `gatherRecapInput` is a heavy
// per-period gather, and #2657's "computable for all visible months in one pass"
// needs its own design. Until that lands the card states ledger structure — how much
// is in here — and makes no health claim it would then have to un-say.
//
// EXPANSION IS URL STATE, not client state. A collapsed month renders none of its
// rows, so the fold is a real saving in bytes and in paint rather than
// `display: none`; and an expanded month is a shareable, bookmarkable, back-button
// -addressable link, which is what keeps "the reader can still find the old entry
// they came for" true rather than hoped for.

import { MONTHS_LONG, shiftDateStr } from "./date";

// The event-grained span, in days, ending on the subject's today (inclusive). 14 is
// the "Load more" boundary Training already uses, and it is STABLE in a way a
// calendar month is not.
export const TIMELINE_RECENT_DAYS = 14;

// The query param that names which folds are open, and the reserved value the ahead
// fold answers to (a month is named by its own `YYYY-MM` key, which can never collide
// with it).
export const TIMELINE_OPEN_PARAM = "open";
export const TIMELINE_AHEAD_KEY = "ahead";

/** The minimum a windowed day group has to be. Both feeds' day shapes satisfy it. */
export interface WindowableDay {
  date: string;
  events: unknown[];
}

/** One collapsible band: what is inside it, how much, and whether it is open. */
export interface TimelineFold<D> {
  /** `ahead`, or the month's `YYYY-MM` key. */
  key: string;
  /** What the fold's header calls itself: "Scheduled ahead" / "March 2026". */
  label: string;
  /** The day groups inside, newest first. Present whether open or closed — the
   *  RENDERER is what skips a closed fold's rows. */
  days: D[];
  dayCount: number;
  eventCount: number;
  open: boolean;
}

/**
 * One earlier calendar year, holding its own month folds. `days` is every day in the
 * year (newest first) so a year answers the same questions a month does; the RENDERER
 * never paints them directly — it paints the month cards, and a month paints its days.
 */
export interface TimelineYearFold<D> extends TimelineFold<D> {
  months: TimelineFold<D>[];
  monthCount: number;
}

export interface TimelineWindowed<D> {
  /** Null when nothing is dated after today — the common case. */
  ahead: TimelineFold<D> | null;
  /** The event-grained recent band, newest first. */
  recent: D[];
  /** Older months OF THE CURRENT YEAR, newest first. */
  months: TimelineFold<D>[];
  /** Earlier years, newest first. Each holds its own month folds. */
  years: TimelineYearFold<D>[];
  /** The first day of the recent band (its inclusive lower bound). */
  recentFrom: string;
}

/** The `YYYY-MM` fold key a date belongs to. */
export function timelineMonthKey(date: string): string {
  return date.slice(0, 7);
}

/** The `YYYY` fold key a date (or a month key) belongs to. */
export function timelineYearKey(date: string): string {
  return date.slice(0, 4);
}

/** "2026-03" → "March 2026". A key that is not a real month renders itself. */
export function timelineMonthLabel(key: string): string {
  const month = MONTHS_LONG[Number(key.slice(5, 7)) - 1];
  return month ? `${month} ${key.slice(0, 4)}` : key;
}

/**
 * The `?open=` values, from a Next `searchParams` entry. Accepts the reserved
 * `ahead` key, `YYYY` year keys and `YYYY-MM` month keys; anything else is dropped, so
 * a hand-edited URL can only ever open less than it asked for, never break the page.
 */
export function parseTimelineOpen(
  value: string | string[] | undefined
): Set<string> {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set<string>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const key = part.trim();
      if (
        key === TIMELINE_AHEAD_KEY ||
        /^\d{4}$/.test(key) ||
        /^\d{4}-(0[1-9]|1[0-2])$/.test(key)
      ) {
        out.add(key);
      }
    }
  }
  return out;
}

/**
 * The `?open=` set with one fold key flipped, sorted so the same open set always
 * produces the same URL (a stable href is a cacheable href, and a stable one is what
 * makes "did this link change?" answerable in a test).
 *
 * `fold` is what makes a YEAR closable, and it carries TWO things because either alone
 * is a bug. A year's open state is DERIVED, so a year opened by the month inside it has
 * no key of its own in the set: asking `open.has("2025")` answers false and the toggle
 * would ADD a key to a card the reader just asked to shut. And dropping the year key
 * alone would leave the derivation to re-open it on the next render. So the caller
 * states the open state it actually rendered, and the descendants that state was
 * derived from, and closing drops both.
 *
 * Omit it for a fold whose open state IS its key — the ahead fold and every month —
 * where set membership is the same answer.
 *
 * OPENING a year touches only the year: the months inside arrive collapsed, which is
 * the point of the level.
 */
export function toggledTimelineOpen(
  open: ReadonlySet<string>,
  key: string,
  fold?: { open: boolean; descendants: readonly string[] }
): string[] {
  const next = new Set(open);
  if (fold ? fold.open : next.has(key)) {
    next.delete(key);
    for (const child of fold?.descendants ?? []) next.delete(child);
  } else {
    next.add(key);
  }
  return [...next].sort();
}

/**
 * The always-present count line under a fold's label (#1504 grammar). A year states
 * its MONTHS rather than its days — "180 events · 3 months" — because the thing it is
 * standing in for, and the thing a tap reveals, is a stack of month cards.
 */
export function timelineFoldCounts(fold: {
  dayCount: number;
  eventCount: number;
  monthCount?: number;
}): string {
  const events = `${fold.eventCount} event${fold.eventCount === 1 ? "" : "s"}`;
  if (fold.monthCount != null) {
    return `${events} · ${fold.monthCount} month${fold.monthCount === 1 ? "" : "s"}`;
  }
  const days = `${fold.dayCount} day${fold.dayCount === 1 ? "" : "s"}`;
  return `${events} · ${days}`;
}

function makeFold<D extends WindowableDay>(
  key: string,
  label: string,
  days: D[],
  open: boolean
): TimelineFold<D> {
  let eventCount = 0;
  for (const day of days) eventCount += day.events.length;
  return { key, label, days, dayCount: days.length, eventCount, open };
}

/**
 * Split newest-first day groups into the ahead fold, the recent band, the current
 * year's month folds and one fold per earlier year.
 *
 * `open` is the parsed `?open=` set. One rule is not in it: when the recent band is
 * EMPTY and nothing older was asked for, the newest month opens on arrival — a profile
 * that has not logged in three weeks must land on its history, not on a stack of shut
 * doors. It is deliberately conditioned on "nothing older is open" rather than on
 * "this month is not open", so an explicit choice is never second-guessed. The month
 * it opens carries its year open with it through the usual derivation, so the rule
 * needs no separate clause for a profile whose newest history is years old.
 */
export function windowTimelineDays<D extends WindowableDay>(
  days: readonly D[],
  todayStr: string,
  open: ReadonlySet<string> = new Set()
): TimelineWindowed<D> {
  const recentFrom = shiftDateStr(todayStr, -(TIMELINE_RECENT_DAYS - 1));
  const currentYear = timelineYearKey(todayStr);
  const aheadDays: D[] = [];
  const recent: D[] = [];
  const monthOrder: string[] = [];
  const byMonth = new Map<string, D[]>();

  for (const day of days) {
    if (day.date > todayStr) {
      aheadDays.push(day);
      continue;
    }
    if (day.date >= recentFrom) {
      recent.push(day);
      continue;
    }
    const key = timelineMonthKey(day.date);
    let bucket = byMonth.get(key);
    if (!bucket) {
      bucket = [];
      byMonth.set(key, bucket);
      monthOrder.push(key);
    }
    bucket.push(day);
  }

  const anyOlderOpen = monthOrder.some(
    (key) => open.has(key) || open.has(timelineYearKey(key))
  );
  const autoOpenKey =
    recent.length === 0 && !anyOlderOpen ? monthOrder[0] : undefined;
  const monthFold = (key: string) =>
    makeFold(
      key,
      timelineMonthLabel(key),
      byMonth.get(key) ?? [],
      open.has(key) || key === autoOpenKey
    );

  const months: TimelineFold<D>[] = [];
  const yearOrder: string[] = [];
  const byYear = new Map<string, TimelineFold<D>[]>();
  for (const key of monthOrder) {
    const year = timelineYearKey(key);
    if (year === currentYear) {
      months.push(monthFold(key));
      continue;
    }
    let bucket = byYear.get(year);
    if (!bucket) {
      bucket = [];
      byYear.set(year, bucket);
      yearOrder.push(year);
    }
    bucket.push(monthFold(key));
  }

  return {
    ahead:
      aheadDays.length > 0
        ? makeFold(
            TIMELINE_AHEAD_KEY,
            "Scheduled ahead",
            aheadDays,
            open.has(TIMELINE_AHEAD_KEY)
          )
        : null,
    recent,
    months,
    years: yearOrder.map((year) => {
      const yearMonths = byYear.get(year) ?? [];
      const yearDays = yearMonths.flatMap((m) => m.days);
      // Derived, not stored: a month the reader opened is a month they must be able to
      // SEE, so the year containing it can never be the thing hiding it.
      const isOpen = open.has(year) || yearMonths.some((month) => month.open);
      return {
        ...makeFold(year, year, yearDays, isOpen),
        months: yearMonths,
        monthCount: yearMonths.length,
      };
    }),
    recentFrom,
  };
}

/** Every day group the windowed feed will actually render, newest first. */
export function renderedTimelineDays<D extends WindowableDay>(
  windowed: TimelineWindowed<D>
): D[] {
  const out: D[] = [];
  if (windowed.ahead?.open) out.push(...windowed.ahead.days);
  out.push(...windowed.recent);
  for (const month of windowed.months) {
    if (month.open) out.push(...month.days);
  }
  for (const year of windowed.years) {
    if (!year.open) continue;
    for (const month of year.months) {
      if (month.open) out.push(...month.days);
    }
  }
  return out;
}

/** Every month fold in the feed, this year's and every earlier year's, newest first. */
export function allTimelineMonths<D extends WindowableDay>(
  windowed: TimelineWindowed<D>
): TimelineFold<D>[] {
  return [...windowed.months, ...windowed.years.flatMap((y) => y.months)];
}

/**
 * The fold a date is hidden inside, or null when that date is rendered (or absent).
 * This is what keeps the "Oldest" jump honest: a jump whose destination is folded
 * away has to OPEN the fold on the way, or it is a link to nothing.
 *
 * It answers with the MONTH key even when a closed year also stands between the reader
 * and that date, and that is not a shortcut: opening the month opens its year by
 * derivation, so one key is genuinely the whole answer.
 */
export function foldKeyHiding<D extends WindowableDay>(
  windowed: TimelineWindowed<D>,
  date: string
): string | null {
  if (windowed.ahead && !windowed.ahead.open) {
    if (windowed.ahead.days.some((d) => d.date === date)) {
      return windowed.ahead.key;
    }
  }
  for (const month of allTimelineMonths(windowed)) {
    if (month.open) continue;
    if (month.days.some((d) => d.date === date)) return month.key;
  }
  return null;
}
