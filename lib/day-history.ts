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

import { shiftDateStr, startOfWeekStr, weekdayOrder } from "./date";
import {
  dayGrid,
  dayGridMonthLabels,
  gridStartFor,
  weekSpan,
} from "./day-grid";
import { intensityLevel } from "./workout-heatmap";
import { doseLedgerHref, DOSE_LEDGER_ALL_KINDS, type AppRoute } from "./hrefs";

export type DayHistoryLevel = 0 | 1 | 2 | 3 | 4;

// ---- Grain (issue #2413) ---------------------------------------------------
//
// Day cells do not scale past a quarter, so the histories used to CLAMP a
// year-scale request back to their day-grain cap — a 1Y range rendered the most
// recent 13 weeks and the range pill did nothing above a quarter, which quietly
// broke the hub's one-shared-range promise. The answer is not more day columns:
// when the REQUESTED window outgrows the day cap, the same history renders at
// WEEK grain. No toggle — the range picker already asks the question, and a
// second control would be a second answer to it.
//
// A bucket is identified by its FIRST day: the day itself, or its week start on
// the profile's week-start alignment (the same alignment `dayHistoryStart` and
// the shared `dayGrid` already use, so the two halves can never disagree about
// where a week begins).
export type DayHistoryGrain = "day" | "week";

// The most week cells a week-grain history renders — the trailing-12-months
// convention already shared with `MAX_FITNESS_WEEKS`.
export const MAX_HISTORY_WEEK_COLUMNS = 53;

// The most week COLUMNS of day cells a history renders before it re-grains.
// This is the substrate's own number, not a lens's: "day cells don't scale past
// a quarter" is a fact about a 7×N grid of 24px squares, and it is equally true
// on Nutrition and on Fitness. It coincides with `NUTRITION_HISTORY_WEEK_CAPS`
// (13) by construction; the Fitness lens's own 53-week cap is about its WEEKLY
// bar charts, where 53 bars read fine and 53×7 day cells do not — so the
// workout history takes this cap rather than its lens's.
export const MAX_HISTORY_DAY_WEEKS = 13;

// The bucket a dated value belongs to at this grain.
export function historyBucket(
  date: string,
  grain: DayHistoryGrain,
  weekStart = 0
): string {
  return grain === "week" ? startOfWeekStr(date, weekStart) : date;
}

// A bucket's last day IF IT RAN COMPLETE — the day itself, or its week's
// seventh. Deliberately not clamped to the window: the difference between this
// and the window's end is exactly what makes a trailing bucket partial.
export function historyBucketSpan(
  bucket: string,
  grain: DayHistoryGrain
): string {
  return grain === "week" ? shiftDateStr(bucket, 6) : bucket;
}

// What a window ending at `end` actually covers of `bucket`. The LAST bucket of
// a week-grain window is normally partial — the current week is three days old
// on a Wednesday — and that is a fact about the WINDOW, not a gap in the data.
// A partial bucket is KEPT (the live week is the signal a trailing trim must
// never eat, exactly as `lib/day-fill` keeps trailing empty days), and it is
// DECLARED, so a half-elapsed week's smaller total is never read as a decline.
export interface HistoryBucketCoverage {
  /** The bucket's last day inside the window. */
  through: string;
  /** The bucket's last day if complete. */
  span: string;
  /** Days of this bucket the window covers: 1 for a day, 1…7 for a week. */
  days: number;
  partial: boolean;
}

export function historyBucketCoverage(
  bucket: string,
  grain: DayHistoryGrain,
  end: string
): HistoryBucketCoverage {
  const span = historyBucketSpan(bucket, grain);
  const through = span > end ? end : span;
  const total = grain === "week" ? 7 : 1;
  let days = 0;
  for (let d = bucket; d <= through; d = shiftDateStr(d, 1)) days += 1;
  return { through, span, days, partial: days < total };
}

// The bucket words. Universal, not per domain: "day" and "week" mean the same
// thing in every history, and the domain's own vocabulary is its UNITS.
export function bucketWord(grain: DayHistoryGrain): {
  one: string;
  many: string;
} {
  return grain === "week"
    ? { one: "week", many: "weeks" }
    : { one: "day", many: "days" };
}

export interface DayHistoryWindow {
  grain: DayHistoryGrain;
  /** Week COLUMNS at day grain; week CELLS at week grain — weeks either way. */
  weeks: number;
}

// The grain decision (#2413). Its input is the UNCLAMPED span: `lensWindow`
// has already clamped its `weeks` to the lens's day-grain cap, and asking the
// clamped number whether it exceeded the cap can only ever answer "no". So the
// desired span is re-derived here from the range's own bounds, week-aligned
// through the shared `weekSpan`.
//
// At day grain the lens's clamped column count passes through UNCHANGED — a
// 90D window renders exactly what it rendered before this existed.
export function dayHistoryWindow(opts: {
  /** The range's own first day, or null for a window open at the start. */
  from: string | null;
  /** The window's anchor (`lensWindow`'s `to` — never in the future). */
  to: string;
  /** The lens's already-clamped day-grain column count. */
  weeks: number;
  /** Day-grain cap. Defaults to the substrate's `MAX_HISTORY_DAY_WEEKS`. */
  maxDayWeeks?: number;
  weekStart?: number;
}): DayHistoryWindow {
  const maxDayWeeks = opts.maxDayWeeks ?? MAX_HISTORY_DAY_WEEKS;
  const desired =
    opts.from == null ? null : weekSpan(opts.from, opts.to, opts.weekStart ?? 0);
  // An unbounded ("All time") window always outgrows the cap; a bounded one
  // does so only STRICTLY above it, so a range that resolves to exactly the cap
  // keeps its day cells.
  if (desired != null && desired <= maxDayWeeks) {
    return { grain: "day", weeks: opts.weeks };
  }
  return {
    grain: "week",
    weeks: Math.min(
      MAX_HISTORY_WEEK_COLUMNS,
      desired ?? MAX_HISTORY_WEEK_COLUMNS
    ),
  };
}

export type DayHistoryDomainKey = "food" | "workout" | "dose" | "practice";
export type DayHistoryRampKey = "activity" | "observation";
export type DayHistoryCalendarKind = "coverage" | "quantity";

export interface DayHistoryDomainSpec {
  unitOne: string;
  unitMany: string;
  groupOne: string;
  groupMany: string;
  ramp: DayHistoryRampKey;
  calendarKind: DayHistoryCalendarKind;
  calendarTitle: string;
  // The strip's heading at week grain — declared, never derived by swapping
  // "day" for "week" in the day title.
  weekCalendarTitle: string;
  matrixTitle: string;
  helperText: string;
  // Exact visible vocabulary for levels 0…4. The renderer shows this instead
  // of an unexplained "Less / More" gradient. The week-grain twin names the
  // week ladder's own buckets — a scale legend that describes a different
  // ladder than the cells it sits beside is worse than none.
  levelLabels: readonly [string, string, string, string, string];
  weekLevelLabels: readonly [string, string, string, string, string];
  // Suffix for the per-cell `detail` quantity in hover copy (workout minutes).
  detailSuffix?: string;
  // Day-TOTAL → calendar color bucket.
  calendarLevel(total: number): DayHistoryLevel;
  // Per-group per-day value → matrix cell bucket.
  cellLevel(value: number): DayHistoryLevel;
  // The WEEK-grain twins (#2413). Declared per domain per grain for the same
  // reason the calendar/cell split is: a ladder that saturates says nothing, and
  // a week holds up to seven days of the day ladder's input. Never derived from
  // the day ladder at call time — the completeness test below fails a domain
  // that declares one and not the other.
  weekCellLevel(value: number): DayHistoryLevel;
  weekStripLevel(total: number): DayHistoryLevel;
  // The domain's own answer to "show me that bucket's rows". This is declared
  // here because the selection panel is client state and cannot receive a
  // function prop across the server/client boundary. It takes a SPAN, not a
  // day, because a week-grain cell selects a week (#2413); at day grain both
  // bounds are the same day.
  dayLink?: {
    label: string;
    href(from: string, to: string): AppRoute;
  };
}

// A weekly quantity ladder: the shared 1/2/3/4+ day ladder with its boundaries
// taken ×7, i.e. "about one a day" is the first step and four-a-day the last.
export function weeklyIntensityLevel(count: number): DayHistoryLevel {
  if (count <= 0) return 0;
  if (count <= 7) return 1;
  if (count <= 14) return 2;
  if (count <= 21) return 3;
  return 4;
}

// A single food group's week: one or two servings of a group across a week is a
// trace, five to seven is roughly daily. Deliberately not ×7 of the day ladder —
// a group logged four times in a WEEK is common, and 4+ as the top step would
// flatten the whole matrix.
function foodWeekCellLevel(value: number): DayHistoryLevel {
  if (value <= 0) return 0;
  if (value <= 2) return 1;
  if (value <= 4) return 2;
  if (value <= 7) return 3;
  return 4;
}

// The declared per-domain policies. Every matrix ladder is the shared 1/2/3/4+
// `intensityLevel` — a single group/item rarely exceeds a handful per day. The
// quantity ladders are 1/2/3/4+. Workout/practice calendars use that quantity;
// food/dose calendars are binary COVERAGE because larger serving/dose totals
// are observations, not success states. Their matrices retain quantity.
//
// At WEEK grain each of those decisions is restated rather than rescaled by
// reflex: the coverage calendars stay COVERAGE (a twelve-serving week must not
// glow better than a three-serving one for exactly the reason a twelve-serving
// day must not), while the quantity ones take the ×7 ladder.
export const DAY_HISTORY_DOMAINS: Record<
  DayHistoryDomainKey,
  DayHistoryDomainSpec
> = {
  food: {
    unitOne: "serving",
    unitMany: "servings",
    groupOne: "food group",
    groupMany: "food groups",
    ramp: "observation",
    calendarKind: "coverage",
    calendarTitle: "Days logged",
    weekCalendarTitle: "Weeks logged",
    matrixTitle: "By food group",
    helperText:
      "Calendar: days you logged food. Matrix: each day by food group. Filter food groups or select a day or row for details.",
    levelLabels: ["0", "1", "2", "3", "4+"],
    weekLevelLabels: ["0", "1–2", "3–4", "5–7", "8+"],
    // The aggregate calendar answers COVERAGE for food. Total servings are not
    // a quality score, so a twelve-serving day must not glow "better" than a
    // three-serving day. Quantity remains visible in the selected-day panel and
    // in the per-group matrix, where its subject is unambiguous.
    calendarLevel: (total) => (total > 0 ? 1 : 0),
    cellLevel: intensityLevel,
    weekCellLevel: foodWeekCellLevel,
    weekStripLevel: (total) => (total > 0 ? 1 : 0),
  },
  workout: {
    unitOne: "session",
    unitMany: "sessions",
    groupOne: "activity",
    groupMany: "activities",
    ramp: "activity",
    calendarKind: "quantity",
    calendarTitle: "Active days",
    weekCalendarTitle: "Active weeks",
    matrixTitle: "By activity",
    helperText:
      "Calendar: days you worked out. Matrix: each day by activity. Filter activities or select a day or row for details.",
    levelLabels: ["0", "1", "2", "3", "4+"],
    weekLevelLabels: ["0", "1", "2", "3", "4+"],
    detailSuffix: "min",
    calendarLevel: intensityLevel,
    cellLevel: intensityLevel,
    // One activity type four times in a week is still a strong week for THAT
    // activity, so the cell ladder is unchanged; the strip totals every
    // activity and takes the weekly ladder.
    weekCellLevel: intensityLevel,
    weekStripLevel: weeklyIntensityLevel,
  },
  dose: {
    unitOne: "dose",
    unitMany: "doses",
    groupOne: "item",
    groupMany: "items",
    ramp: "observation",
    calendarKind: "coverage",
    calendarTitle: "Days recorded",
    weekCalendarTitle: "Weeks recorded",
    matrixTitle: "By item",
    helperText:
      "Calendar: days you confirmed doses. Matrix: each day by item. Filter items or select a day or row for details. Shows what was taken, not what was due or missed.",
    levelLabels: ["0", "1", "2", "3", "4+"],
    weekLevelLabels: ["0", "≤7", "≤14", "≤21", "22+"],
    // The chart combines both intake kinds, so its row-level destination does
    // too even though the route lives under the supplement entry surface.
    dayLink: {
      label: "Dose ledger",
      href: (from, to) =>
        doseLedgerHref("supplement", {
          from,
          to,
          kind: DOSE_LEDGER_ALL_KINDS,
        }),
    },
    // As with food, a larger day-total is descriptive rather than desirable.
    calendarLevel: (total) => (total > 0 ? 1 : 0),
    cellLevel: intensityLevel,
    // A daily item lands on 7 a week, so the ×7 ladder is the honest one here:
    // one step per "about a dose a day".
    weekCellLevel: weeklyIntensityLevel,
    weekStripLevel: (total) => (total > 0 ? 1 : 0),
  },
  // Wellness practices share the workout shape exactly (sessions + minutes,
  // 1–2 a day) — a distinct key so the surfaces stay honestly named.
  practice: {
    unitOne: "session",
    unitMany: "sessions",
    groupOne: "practice",
    groupMany: "practices",
    ramp: "activity",
    calendarKind: "quantity",
    calendarTitle: "Active days",
    weekCalendarTitle: "Active weeks",
    matrixTitle: "By practice",
    helperText:
      "Calendar: days you practiced. Matrix: each day by practice. Filter practices or select a day or row for details.",
    levelLabels: ["0", "1", "2", "3", "4+"],
    weekLevelLabels: ["0", "1", "2", "3", "4+"],
    detailSuffix: "min",
    calendarLevel: intensityLevel,
    cellLevel: intensityLevel,
    weekCellLevel: intensityLevel,
    weekStripLevel: weeklyIntensityLevel,
  },
};

// The ladder pair a grain selects. One lookup so no surface picks a ladder by
// writing its own `grain === "week" ? … : …`.
export function historyCellLevel(
  spec: DayHistoryDomainSpec,
  grain: DayHistoryGrain
): (value: number) => DayHistoryLevel {
  return grain === "week" ? spec.weekCellLevel : spec.cellLevel;
}

export function historyAggregateLevel(
  spec: DayHistoryDomainSpec,
  grain: DayHistoryGrain
): (total: number) => DayHistoryLevel {
  return grain === "week" ? spec.weekStripLevel : spec.calendarLevel;
}

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
  /** The BUCKET's first day — the day itself, or the week's start (#2413). */
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
  cells: DayHistoryCell[]; // one per bucket, ascending — never sparse
  foldedKeys: string[]; // non-empty only on the fold row
}

// The calendar days in [start, end] inclusive, ascending. Small and local so
// the matrix and the calendar can never disagree on the day list.
export function historyDays(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = shiftDateStr(d, 1)) out.push(d);
  return out;
}

// The week-grain twin (#2413): the WEEK STARTS covering [start, end], ascending.
// `start` is already a week start on every real call (it comes from
// `dayHistoryStart`), but a mid-week `start` is aligned back rather than
// dropping the days before it — a bucket list that omitted them would silently
// disagree with the totals, which bucket every value they are given.
export function historyWeeks(
  start: string,
  end: string,
  weekStart = 0
): string[] {
  const out: string[] = [];
  for (
    let w = startOfWeekStr(start, weekStart);
    w <= end;
    w = shiftDateStr(w, 7)
  )
    out.push(w);
  return out;
}

// The bucket list at either grain — the ONE day/week list both halves and the
// matrix read, so they can never disagree about what a column is.
export function historyBuckets(
  start: string,
  end: string,
  grain: DayHistoryGrain,
  weekStart = 0
): string[] {
  return grain === "week"
    ? historyWeeks(start, end, weekStart)
    : historyDays(start, end);
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
  selected: ReadonlySet<string> | null,
  opts: { grain?: DayHistoryGrain; weekStart?: number } = {}
): Map<string, number> {
  const grain = opts.grain ?? "day";
  const weekStart = opts.weekStart ?? 0;
  const totals = new Map<string, number>();
  for (const v of values) {
    if (!(v.value > 0)) continue;
    if (selected && !selected.has(v.group)) continue;
    const key = historyBucket(v.date, grain, weekStart);
    totals.set(key, (totals.get(key) ?? 0) + v.value);
  }
  return totals;
}

// Build the matrix rows: one per selected group with any value in the window,
// ranked by window total (descending; ties keep the caller's vocabulary
// order), rows beyond `maxRows` folded into one aggregate row so a 20-group
// history stays scannable. A fold of ONE would hide nothing — a single
// overflow group keeps its own row.
export function buildDayHistoryRows(opts: {
  /** Bucket keys ascending, from `historyBuckets` — days, or week starts. */
  days: string[];
  values: DayHistoryValue[];
  groups: DayHistoryGroupMeta[];
  selected: ReadonlySet<string> | null; // null = all groups
  maxRows: number;
  cellLevel: (value: number) => DayHistoryLevel;
  today: string;
  /** Bucket grain (#2413). Omitted = day, the shape every caller had. */
  grain?: DayHistoryGrain;
  weekStart?: number;
}): DayHistoryRow[] {
  const { days, values, groups, selected, maxRows, cellLevel, today } = opts;
  const grain = opts.grain ?? "day";
  const weekStart = opts.weekStart ?? 0;
  // At week grain "today" is the CURRENT WEEK's bucket: the today marker asks
  // which cell the reader is standing in, and at this grain that is a week.
  const todayBucket = historyBucket(today, grain, weekStart);
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
    const bucket = historyBucket(v.date, grain, weekStart);
    const cell = dates.get(bucket) ?? { v: 0, d: 0, notes: [] };
    cell.v += v.value;
    cell.d += v.detail ?? 0;
    if (v.note && !cell.notes.includes(v.note)) cell.notes.push(v.note);
    dates.set(bucket, cell);
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
        today: date === todayBucket,
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

// ---- Week strip: the calendar half at week grain (#2413) -------------------
//
// At week grain the 7-row day-of-week shape is meaningless — every cell IS a
// week — so the calendar collapses to a single-row strip, one cell per week,
// colored by the week's total (`ActiveDaysStrip` is the in-app precedent).
// Still an ADAPTER over the shared `dayGrid`: the grid decides which days a
// week column holds, this decides what a week MEANS. Nothing here re-derives
// week arithmetic.
export interface DayHistoryStripCell {
  /** The week's first day — its bucket identity. */
  date: string;
  /** The week's seventh day, whether or not the window reaches it. */
  span: string;
  /** The week's last day inside the window. */
  through: string;
  /** Days of the week the window covers (1…7). */
  days: number;
  /** True when the window stops mid-week — the live trailing week. */
  partial: boolean;
  value: number;
  level: DayHistoryLevel;
  today: boolean;
}

export interface DayHistoryStrip {
  cells: DayHistoryStripCell[]; // oldest → newest
  monthLabels: { col: number; label: string }[];
  start: string;
  end: string;
  /** Weeks carrying any value — the strip's twin of `activeDays`. */
  activeWeeks: number;
  totalValue: number;
}

export function buildDayHistoryStrip(opts: {
  /** WEEK-bucketed totals, i.e. `dayTotals(..., { grain: "week", weekStart })`. */
  totals: ReadonlyMap<string, number>;
  end: string;
  weeks: number;
  weekStart?: number;
  stripLevel: (total: number) => DayHistoryLevel;
  today: string;
}): DayHistoryStrip {
  const { totals, end, weeks, stripLevel, today } = opts;
  const weekStart = opts.weekStart ?? 0;
  const start = dayHistoryStart(end, weeks, weekStart);
  const grid = dayGrid({ start, end, weekStart, orientation: "week-columns" });
  const todayWeek = startOfWeekStr(today, weekStart);

  let activeWeeks = 0;
  let totalValue = 0;

  const cells = grid.weeks.map((week) => {
    const date = week[0].date;
    const coverage = historyBucketCoverage(date, "week", end);
    const value = totals.get(date) ?? 0;
    if (value > 0) {
      activeWeeks += 1;
      totalValue += value;
    }
    return {
      date,
      span: coverage.span,
      through: coverage.through,
      days: coverage.days,
      partial: coverage.partial,
      value,
      level: stripLevel(value),
      today: date === todayWeek,
    } satisfies DayHistoryStripCell;
  });

  return {
    cells,
    monthLabels: dayGridMonthLabels(grid),
    start,
    end,
    activeWeeks,
    totalValue,
  };
}
