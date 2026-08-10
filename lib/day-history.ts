// Generalized group×day history — the ONE pure model behind the "what did I
// actually log, day by day" surfaces: the Trends → Nutrition intake history
// (calendar + matrix) and the Trends → Fitness sessions-by-type matrix. Two
// halves over the same per-day per-group values:
//
//   - a CALENDAR (coverage): one cell per day on the shared `dayGrid`, colored
//     by the day's total — "how consistently did I log/do this".
//   - a MATRIX (composition): one row per group, one cell per day — "WHAT was
//     it", the question a day-total can't answer.
//
// A domain plugs in only what is genuinely its own — its unit words and its
// level ladders — through a DECLARED spec in DAY_HISTORY_DOMAINS (the
// fitness-freshness pattern: policy is data, and a completeness test fails an
// undeclared domain). Everything else (ranking, folding, densifying, the grid)
// is shared, so a third domain (symptoms, doses) is a registry entry, not a
// fork.
//
// Pure — no DB, no clock. The caller supplies the window and "today". Group
// filtering happens HERE (a `selected` set) because the filter chips are client
// state: the client re-runs these builders, so the level policy must live in a
// client-importable module, selected by domain key — never a function prop
// across the server/client boundary.

import { shiftDateStr, weekdayOrder } from "./date";
import {
  dayGrid,
  dayGridMonthLabels,
  gridStartFor,
  weekSpan,
} from "./day-grid";
import { intensityLevel } from "./workout-heatmap";

export type DayHistoryLevel = 0 | 1 | 2 | 3 | 4;

export type DayHistoryDomainKey = "food" | "workout" | "dose" | "practice";

export interface DayHistoryDomainSpec {
  unitOne: string;
  unitMany: string;
  // Suffix for the per-cell `detail` quantity in hover copy (workout minutes).
  detailSuffix?: string;
  // Day-TOTAL → calendar color bucket.
  calendarLevel(total: number): DayHistoryLevel;
  // Per-group per-day value → matrix cell bucket.
  cellLevel(value: number): DayHistoryLevel;
}

// The declared per-domain policies. Every matrix ladder is the shared 1/2/3/4+
// `intensityLevel` — a single group/item rarely exceeds a handful per day. The
// calendars differ per domain because DAY totals live on different scales: a
// workout day holds 1–2 sessions so the session ladder reads fine, an active
// food logger's day runs 3–10 servings, and a stacked supplement/med routine
// confirms 5–15 doses — the wider ladders keep those from saturating at 4.
export const DAY_HISTORY_DOMAINS: Record<
  DayHistoryDomainKey,
  DayHistoryDomainSpec
> = {
  food: {
    unitOne: "serving",
    unitMany: "servings",
    calendarLevel: (total) =>
      total <= 0 ? 0 : total <= 2 ? 1 : total <= 4 ? 2 : total <= 7 ? 3 : 4,
    cellLevel: intensityLevel,
  },
  workout: {
    unitOne: "session",
    unitMany: "sessions",
    detailSuffix: "min",
    calendarLevel: intensityLevel,
    cellLevel: intensityLevel,
  },
  dose: {
    unitOne: "dose",
    unitMany: "doses",
    calendarLevel: (total) =>
      total <= 0 ? 0 : total <= 3 ? 1 : total <= 6 ? 2 : total <= 10 ? 3 : 4,
    cellLevel: intensityLevel,
  },
  // Wellness practices share the workout shape exactly (sessions + minutes,
  // 1–2 a day) — a distinct key so the surfaces stay honestly named.
  practice: {
    unitOne: "session",
    unitMany: "sessions",
    detailSuffix: "min",
    calendarLevel: intensityLevel,
    cellLevel: intensityLevel,
  },
};

// One dated per-group value (servings of a food group, sessions of an activity
// type). The query layer maps its rows to this.
export interface DayHistoryValue {
  date: string; // YYYY-MM-DD, profile-local
  group: string;
  value: number;
  // Optional secondary quantity for hover copy (workout minutes). Never colors
  // a cell — duration is frequently null upstream, so a minutes-driven level
  // would read half the matrix as empty (the workout-heatmap precedent).
  detail?: number;
  // Optional free-text annotation for hover copy (a dose's amount). Unique
  // notes are collected per cell, never summed.
  note?: string;
}

// A group's display identity, supplied by the surface from its own vocabulary
// (food catalog, activity-type labels). `foodSlug` lets the renderer resolve a
// FoodGroupIcon; `tier` tints it. Both are food-only and optional.
export interface DayHistoryGroupMeta {
  key: string;
  label: string;
  // Abbreviated display form for dense surfaces (chips, matrix row labels);
  // the full label stays in tooltips and aria copy. Optional — falls back to
  // `label`.
  short?: string;
  foodSlug?: string;
  tier?: string;
}

export interface DayHistoryCell {
  date: string;
  value: number;
  detail: number;
  notes: string[]; // unique value notes (dose amounts), first-seen order
  level: DayHistoryLevel;
  today: boolean;
}

// The sentinel key of the fold row — never a real group key.
export const FOLDED_ROW_KEY = "__folded__";

export interface DayHistoryRow {
  key: string; // group key, or FOLDED_ROW_KEY
  label: string;
  short: string; // abbreviated label for the row gutter (falls back to label)
  foodSlug: string | null;
  tier: string | null;
  total: number;
  activeDays: number;
  cells: DayHistoryCell[]; // one per day, ascending — never sparse
  foldedKeys: string[]; // non-empty only on the fold row
}

// The calendar days in [start, end] inclusive, ascending. Small and local so
// the matrix and the calendar can never disagree on the day list.
export function historyDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) out.push(d);
  return out;
}

// The week-column count after trimming LEADING all-empty weeks — the day-fill
// doctrine applied at week grain: a window that opens before the first logged
// day renders a wall of empty cells that says nothing, so the grid starts on
// the week of the first UNFILTERED value instead. Unfiltered deliberately:
// toggling a chip must never reflow the grid. Trailing emptiness is KEPT — a
// quiet recent stretch is the live signal. No data at all keeps the full
// window (the caller's empty-state decision, not this one's).
export function activeHistoryWeeks(
  values: DayHistoryValue[],
  end: string,
  weeks: number,
  weekStart = 0
): number {
  let first: string | null = null;
  for (const v of values) {
    if (v.value > 0 && v.date <= end && (first === null || v.date < first))
      first = v.date;
  }
  if (first === null) return weeks;
  return Math.max(1, Math.min(weeks, weekSpan(first, end, weekStart)));
}

// Per-day totals over the selected groups (`null` = all). The calendar's input.
export function dayTotals(
  values: DayHistoryValue[],
  selected: ReadonlySet<string> | null
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const v of values) {
    if (!(v.value > 0)) continue;
    if (selected && !selected.has(v.group)) continue;
    totals.set(v.date, (totals.get(v.date) ?? 0) + v.value);
  }
  return totals;
}

// Build the matrix rows: one per selected group with any value in the window,
// ranked by window total (descending; ties keep the caller's vocabulary
// order), rows beyond `maxRows` folded into one aggregate row so a 20-group
// history stays scannable. A fold of ONE would hide nothing — a single
// overflow group keeps its own row.
export function buildDayHistoryRows(opts: {
  days: string[]; // ascending, from historyDays
  values: DayHistoryValue[];
  groups: DayHistoryGroupMeta[];
  selected: ReadonlySet<string> | null; // null = all groups
  maxRows: number;
  cellLevel: (value: number) => DayHistoryLevel;
  today: string;
}): DayHistoryRow[] {
  const { days, values, groups, selected, maxRows, cellLevel, today } = opts;
  const meta = new Map(groups.map((g) => [g.key, g]));
  const vocabOrder = new Map(groups.map((g, i) => [g.key, i]));

  // Sum per group+date and per group, honoring the filter.
  const byGroupDate = new Map<
    string,
    Map<string, { v: number; d: number; notes: string[] }>
  >();
  const totals = new Map<string, number>();
  for (const v of values) {
    if (!(v.value > 0)) continue;
    if (selected && !selected.has(v.group)) continue;
    let dates = byGroupDate.get(v.group);
    if (!dates) byGroupDate.set(v.group, (dates = new Map()));
    const cell = dates.get(v.date) ?? { v: 0, d: 0, notes: [] };
    cell.v += v.value;
    cell.d += v.detail ?? 0;
    if (v.note && !cell.notes.includes(v.note)) cell.notes.push(v.note);
    dates.set(v.date, cell);
    totals.set(v.group, (totals.get(v.group) ?? 0) + v.value);
  }

  const ranked = [...totals.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    const ai = vocabOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
    const bi = vocabOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  const keep = ranked.length > maxRows ? ranked.slice(0, maxRows - 1) : ranked;
  const folded = ranked.length > maxRows ? ranked.slice(maxRows - 1) : [];

  const rowFor = (
    key: string,
    label: string,
    keys: string[]
  ): DayHistoryRow => {
    let total = 0;
    let activeDays = 0;
    const cells = days.map((date) => {
      let v = 0;
      let d = 0;
      const notes: string[] = [];
      for (const k of keys) {
        const cell = byGroupDate.get(k)?.get(date);
        if (cell) {
          v += cell.v;
          d += cell.d;
          for (const n of cell.notes) if (!notes.includes(n)) notes.push(n);
        }
      }
      if (v > 0) {
        total += v;
        activeDays += 1;
      }
      return {
        date,
        value: v,
        detail: d,
        notes,
        level: cellLevel(v),
        today: date === today,
      } satisfies DayHistoryCell;
    });
    const m = keys.length === 1 ? meta.get(keys[0]) : undefined;
    return {
      key,
      label,
      short: m?.short ?? label,
      foodSlug: m?.foodSlug ?? null,
      tier: m?.tier ?? null,
      total,
      activeDays,
      cells,
      foldedKeys: keys.length === 1 ? [] : keys,
    };
  };

  const rows = keep.map(([key]) =>
    rowFor(key, meta.get(key)?.label ?? key, [key])
  );
  if (folded.length === 1) {
    const [key] = folded[0];
    rows.push(rowFor(key, meta.get(key)?.label ?? key, [key]));
  } else if (folded.length > 1) {
    rows.push(
      rowFor(
        FOLDED_ROW_KEY,
        `+${folded.length} more`,
        folded.map(([key]) => key)
      )
    );
  }
  return rows;
}

// ---- Calendar half ---------------------------------------------------------

export interface DayHistoryCalendarCell {
  date: string;
  value: number;
  level: DayHistoryLevel;
  future: boolean; // trailing padding after `end` — renders blank
  today: boolean;
}

export interface DayHistoryCalendar {
  columns: DayHistoryCalendarCell[][]; // week columns oldest→newest, 7 cells each
  weekdayOrder: number[]; // 0=Sun … 6=Sat, in row order
  monthLabels: { col: number; label: string }[];
  start: string;
  end: string;
  activeDays: number;
  totalValue: number;
}

// The grid's first day for a `weeks`-column history ending on the week of
// `end` — shared with the matrix so both halves cover identical days.
export function dayHistoryStart(
  end: string,
  weeks: number,
  weekStart = 0
): string {
  return gridStartFor(end, weeks, weekStart);
}

// Assemble the calendar from per-day totals (from `dayTotals`, so it honors
// the same group filter as the matrix). An ADAPTER over the shared `dayGrid`
// (#2042): the grid decides which day sits in which cell, this decides what a
// day means (total, level, today).
export function buildDayHistoryCalendar(opts: {
  totals: ReadonlyMap<string, number>;
  end: string;
  weeks: number;
  weekStart?: number;
  calendarLevel: (total: number) => DayHistoryLevel;
  today: string;
}): DayHistoryCalendar {
  const { totals, end, weeks, calendarLevel, today } = opts;
  const weekStart = opts.weekStart ?? 0;
  const start = dayHistoryStart(end, weeks, weekStart);
  const grid = dayGrid({ start, end, weekStart, orientation: "week-columns" });

  let activeDays = 0;
  let totalValue = 0;

  const columns = grid.weeks.map((cells) =>
    cells.map((cell) => {
      const future = cell.position === "after";
      const value = future ? 0 : (totals.get(cell.date) ?? 0);
      if (value > 0) {
        activeDays += 1;
        totalValue += value;
      }
      return {
        date: cell.date,
        value,
        level: calendarLevel(value),
        future,
        today: !future && cell.date === today,
      } satisfies DayHistoryCalendarCell;
    })
  );

  return {
    columns,
    weekdayOrder: weekdayOrder(weekStart),
    monthLabels: dayGridMonthLabels(grid),
    start,
    end,
    activeDays,
    totalValue,
  };
}
