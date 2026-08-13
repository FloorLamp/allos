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

export interface TimelineWindowed<D> {
  /** Null when nothing is dated after today — the common case. */
  ahead: TimelineFold<D> | null;
  /** The event-grained recent band, newest first. */
  recent: D[];
  /** Older months, newest first. */
  months: TimelineFold<D>[];
  /** The first day of the recent band (its inclusive lower bound). */
  recentFrom: string;
}

/** The `YYYY-MM` fold key a date belongs to. */
export function timelineMonthKey(date: string): string {
  return date.slice(0, 7);
}

/** "2026-03" → "March 2026". A key that is not a real month renders itself. */
export function timelineMonthLabel(key: string): string {
  const month = MONTHS_LONG[Number(key.slice(5, 7)) - 1];
  return month ? `${month} ${key.slice(0, 4)}` : key;
}

/**
 * The `?open=` values, from a Next `searchParams` entry. Accepts the reserved
 * `ahead` key and `YYYY-MM` month keys; anything else is dropped, so a hand-edited
 * URL can only ever open less than it asked for, never break the page.
 */
export function parseTimelineOpen(
  value: string | string[] | undefined
): Set<string> {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set<string>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const key = part.trim();
      if (key === TIMELINE_AHEAD_KEY || /^\d{4}-(0[1-9]|1[0-2])$/.test(key)) {
        out.add(key);
      }
    }
  }
  return out;
}

/** The always-present count line under a fold's label (#1504 grammar). */
export function timelineFoldCounts(fold: {
  dayCount: number;
  eventCount: number;
}): string {
  const events = `${fold.eventCount} event${fold.eventCount === 1 ? "" : "s"}`;
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
 * Split newest-first day groups into the ahead fold, the recent band and the older
 * month folds.
 *
 * `open` is the parsed `?open=` set. One rule is not in it: when the recent band is
 * EMPTY and no month was asked for, the newest month opens on arrival — a profile
 * that has not logged in three weeks must land on its history, not on a stack of shut
 * doors. It is deliberately conditioned on "no month is open" rather than on "this
 * month is not open", so an explicit choice is never second-guessed.
 */
export function windowTimelineDays<D extends WindowableDay>(
  days: readonly D[],
  todayStr: string,
  open: ReadonlySet<string> = new Set()
): TimelineWindowed<D> {
  const recentFrom = shiftDateStr(todayStr, -(TIMELINE_RECENT_DAYS - 1));
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

  const anyMonthOpen = monthOrder.some((key) => open.has(key));
  const autoOpenKey =
    recent.length === 0 && !anyMonthOpen ? monthOrder[0] : undefined;

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
    months: monthOrder.map((key) =>
      makeFold(
        key,
        timelineMonthLabel(key),
        byMonth.get(key) ?? [],
        open.has(key) || key === autoOpenKey
      )
    ),
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
  return out;
}

/**
 * The fold a date is hidden inside, or null when that date is rendered (or absent).
 * This is what keeps the "Oldest" jump honest: a jump whose destination is folded
 * away has to OPEN the fold on the way, or it is a link to nothing.
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
  for (const month of windowed.months) {
    if (month.open) continue;
    if (month.days.some((d) => d.date === date)) return month.key;
  }
  return null;
}
