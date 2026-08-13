// THE WEEK SPINE (#2566, Viz 1) — the profile's own training week as ONE band of
// seven days, pure and DB-free.
//
// What it replaces: Training → Overview's "This week" card was two numbers,
// `Sessions: 4` and `Days: 3` — a tally with no shape. Which days, and what kind of
// session, were nowhere on the card; the routine's state lived in a second card in a
// different vocabulary, and the two never composed. This module lays the same week
// out as days so the tally has a picture, and the caption keeps stating the tally.
//
// WHAT THIS MODULE DOES NOT DO, on purpose:
//
//   • It states no PLAN. The issue's sketch put a "plan tick" under each day — grey
//     where the routine expects a session, green where met. The app's routine model
//     cannot answer that: `resolveTodayRoutineDayIndex` is explicit that "a routine is
//     a SEQUENCE not a calendar", so a routine day has an ordinal, never a weekday.
//     There is no honest "Wednesday is a Push day" to draw, and inventing one would be
//     a claim the data does not carry. The routine's real weekly state — the cadence
//     ledger's `Upper 1/2 · Lower 1/1` counts — is what the caption carries instead.
//   • It computes no SCORE and no verdict. A day with nothing logged is empty, never
//     red: dueness gates nudging, never shame (#2419).
//   • It counts nothing of its own that another surface already counts. The band's
//     `sessions`/`activeDays` fold is the SAME question `getTrainingLogWeekSummary`
//     answers, so the query layer folds ONE row set into both (#221) rather than
//     letting a picture and a caption drift apart.
//
// WOULD IT KNOW IF IT WERE WRONG (#2385). The spine claims comprehension, not
// behaviour: it adds no nudge, no send, no verdict and no score, so effectiveness is
// not its justification and there is nothing here to measure "working". What WOULD
// show it wrong is a disagreement, and that is checkable locally and cheaply: the
// band's fold and `getTrainingLogWeekSummary` must state the same week (the DB-tier
// spec asserts exactly that), and a day's rendered blocks must sum to the count on its
// own cell. Its DECEPTIVE SUCCESS is the one to watch if this ever grows a target
// line: a band that reads "fuller" week over week while sessions get shorter or
// lighter would look like progress and be none — which is why the cell counts
// SESSIONS, says so, and never colours a day by how hard it was.
//
// The day cells are the profile's own week window (calendar mode resetting on the
// configured week-start day, or a rolling trailing seven) — `weekWindowStart` decides,
// nothing here re-derives it (#223). In calendar mode the window's start is the week's
// start and `today` may sit mid-week, so the days after today are AHEAD: rendered as
// part of the week, carrying no claim at all.

import { WEEKDAYS_SHORT, shiftDateStr, weekdayOfDateStr } from "./date";
import { ACTIVITY_TYPES, type ActivityType } from "./types/training";

/** Seven days, always — the band is a week, not a variable-length window. */
export const WEEK_SPINE_DAYS = 7;

/** One (day, type) tally from the week's activities — the query layer's row shape. */
export interface WeekSpineRow {
  date: string;
  type: ActivityType;
  count: number;
}

/**
 * Where a day sits relative to `today`. `ahead` exists only in calendar week mode
 * (a rolling window ends on today), and means exactly "not yet" — never "missed".
 */
export type WeekSpineDayState = "past" | "today" | "ahead";

/** One type's sessions on one day, in the declared `ACTIVITY_TYPES` order. */
export interface WeekSpineBlock {
  type: ActivityType;
  count: number;
}

export interface WeekSpineDay {
  date: string;
  /** "Mon", "Tue", … — the weekday of the stored calendar day, UTC-anchored. */
  weekdayLabel: string;
  state: WeekSpineDayState;
  sessions: number;
  blocks: WeekSpineBlock[];
}

export interface WeekSpine {
  /** Inclusive first day of the band = the profile's week-window start. */
  start: string;
  /** Exactly `WEEK_SPINE_DAYS` cells, oldest first. */
  days: WeekSpineDay[];
  /** Sessions logged across the band. */
  sessions: number;
  /** Distinct days with at least one session across the band. */
  activeDays: number;
}

/**
 * Lay a week's (day, type) tallies onto the seven-day band starting at `start`.
 *
 * Blocks within a day are ordered by the declared `ACTIVITY_TYPES` tuple, never by
 * count or by arrival, so the same mix stacks the same way every render and two days
 * of the same week are read against each other rather than re-sorted.
 *
 * Rows outside [start, start+6] are ignored: the band IS the week, and a row the
 * window's query returned for a later day (a future-dated log in rolling mode) is not
 * this week's picture. The caption's counts come from the week summary, which is the
 * one place that question is answered.
 */
export function buildWeekSpine(input: {
  start: string;
  today: string;
  rows: readonly WeekSpineRow[];
}): WeekSpine {
  const { start, today, rows } = input;

  const byDate = new Map<string, Map<ActivityType, number>>();
  for (const row of rows) {
    if (row.count <= 0) continue;
    let day = byDate.get(row.date);
    if (!day) {
      day = new Map<ActivityType, number>();
      byDate.set(row.date, day);
    }
    day.set(row.type, (day.get(row.type) ?? 0) + row.count);
  }

  const days: WeekSpineDay[] = [];
  for (let i = 0; i < WEEK_SPINE_DAYS; i++) {
    const date = shiftDateStr(start, i);
    const tally = byDate.get(date);
    const blocks: WeekSpineBlock[] = [];
    let sessions = 0;
    for (const type of ACTIVITY_TYPES) {
      const count = tally?.get(type) ?? 0;
      if (count <= 0) continue;
      blocks.push({ type, count });
      sessions += count;
    }
    days.push({
      date,
      weekdayLabel: WEEKDAYS_SHORT[weekdayOfDateStr(date)],
      state: date === today ? "today" : date < today ? "past" : "ahead",
      sessions,
      blocks,
    });
  }

  return {
    start,
    days,
    sessions: days.reduce((n, d) => n + d.sessions, 0),
    activeDays: days.filter((d) => d.sessions > 0).length,
  };
}

// The band's word for each activity type. Exhaustive over `ActivityType` by the
// #2272 tuple discipline, and it borrows the restraint the workout-recap title map
// already shows: `recovery` is the app's MOBILITY work, not training load (#840/#482),
// and `unclassified` means the source did not say — so it gets a word that states the
// absence rather than guessing a discipline.
export const WEEK_SPINE_TYPE_LABEL: Record<ActivityType, string> = {
  strength: "strength",
  cardio: "cardio",
  sport: "sport",
  recovery: "mobility",
  unclassified: "unspecified",
};

/** One day's plain-language summary — the cell's accessible name and tooltip. */
export function weekSpineDaySummary(day: WeekSpineDay): string {
  if (day.state === "ahead") return `${day.date} — ahead`;
  if (day.sessions === 0) return `${day.date} — nothing logged`;
  const parts = day.blocks.map(
    (b) => `${b.count} ${WEEK_SPINE_TYPE_LABEL[b.type]}`
  );
  return `${day.date} — ${parts.join(", ")}`;
}
