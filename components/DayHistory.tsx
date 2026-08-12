"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { chartActivityRamp, chartObservationRamp } from "@/lib/chart-colors";
import {
  formatLongDate,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "@/lib/format-date";
import { monthNames } from "@/lib/date";
import {
  dayHistoryAddHref,
  timelineDayHref,
  timelineRangeHref,
  trainingLogDayHref,
  type AppRoute,
} from "@/lib/hrefs";
import {
  DAY_HISTORY_DOMAINS,
  FOLDED_ROW_KEY,
  activeHistoryWeeks,
  bucketWord,
  buildDayHistoryCalendar,
  buildDayHistoryRows,
  buildDayHistoryStrip,
  dayHistoryStart,
  dayTotals,
  historyAggregateLevel,
  historyBucket,
  historyBucketCoverage,
  historyBuckets,
  historyCellLevel,
  type DayHistoryCalendarCell,
  type DayHistoryDomainKey,
  type DayHistoryGrain,
  type DayHistoryGroupMeta,
  type DayHistoryRow,
  type DayHistoryStripCell,
  type DayHistoryValue,
} from "@/lib/day-history";
import type { FoodGroupTier } from "@/lib/food-groups";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";

// Three-letter weekday labels indexed by 0=Sun … 6=Sat, overlaid on the grid.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Cell geometry, shared by the cells and the overlaid label offsets. The
// calendar cell GROWS from the 24px base to fill the container when the
// window is short (a 4-week range gets ~34px cells, 13 weeks keeps 24).
const CAL_CELL = 24;
const CAL_CELL_MAX = 34;
const CAL_GAP = 3;
const MTX_CELL_W = 18;
const MTX_CELL_H = 26;
const MTX_GAP = 2;
const MTX_ROW_GAP = 3;
const MTX_STEP = MTX_CELL_W + MTX_GAP;
// Extra gap before each new week column in the matrix — the weekly rhythm the
// calendar gets for free from its columns.
const MTX_WEEK_GAP = 5;

// Calendar axis labels stay overlaid so its compact seven-row overview keeps
// every pixel of width. The matrix gets a real reserved header below: date
// labels must never cover the quantity cells they explain.
const OVERLAY_LABEL =
  "pointer-events-none absolute rounded-sm bg-white/70 px-1 text-xs font-semibold uppercase tracking-wide text-slate-700 backdrop-blur-[2px] dark:bg-ink-950/60 dark:text-slate-200";

// The horizontal scroll wrapper both halves share. A small, breakpoint-free
// gutter escape uses nearly all available width without assuming which shell
// owns the page padding. Its matching inner padding leaves focus/selection
// rings room at the clipped edges.
const SCROLLER = "-mx-1 overflow-x-auto px-1 pb-1 pt-2";
const MATRIX_LABEL_FADE =
  "bg-gradient-to-r from-white/70 via-white/70 via-[82%] to-transparent dark:from-ink-950/70 dark:via-ink-950/70";
const PANE_TITLE = "text-sm font-semibold text-slate-800 dark:text-slate-100";
const PANE_META = "text-xs text-slate-500 dark:text-slate-400";
const PANE_ROW = "text-xs text-slate-700 dark:text-slate-200";
const PANE_VALUE =
  "shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// Minutes → compact duration copy for the summary line.
function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder > 0 ? ` ${remainder}m` : ""}`;
}

// The generalized group×bucket history (calendar/strip + matrix) — the client
// half of lib/day-history.ts. One component, four domains (food, workout, dose,
// practice); the
// domain key selects the DECLARED level/wording policy client-side, because
// the group filter chips re-run the pure builders on every toggle and a
// function can never cross the server→client prop boundary.
//
// TWO GRAINS (#2413), one renderer. A column is a DAY or a WEEK, chosen by the
// caller's window, and everything below reads `buckets` rather than days. Only
// the aggregate half genuinely forks: seven rows of day cells become a
// single-row week strip, because at week grain the day-of-week axis says
// nothing. The matrix, the crosshair, the panels, the fold, the trim and the
// today marker are the same code at both grains.
export default function DayHistory({
  domain,
  values,
  groups,
  end,
  weeks,
  weekStart,
  grain = "day",
  today,
  formatPrefs,
  addHref,
  showCalendar = true,
  maxRows = 8,
  testId = "day-history",
}: {
  domain: DayHistoryDomainKey;
  values: DayHistoryValue[];
  // Vocabulary order (catalog order for food); only groups with data.
  groups: DayHistoryGroupMeta[];
  end: string; // the window's last day (never future)
  weeks: number; // week columns (day grain) or week cells (week grain)
  weekStart: number;
  // Bucket grain, decided by the caller's window through `dayHistoryWindow`.
  grain?: DayHistoryGrain;
  today: string;
  formatPrefs: DisplayFormatPrefs;
  // Domain landing page for a new entry. The selected day is appended here,
  // inside the shared client component, so all four panels expose the same
  // close-the-loop action without serializing a callback across RSC.
  addHref?: AppRoute;
  showCalendar?: boolean;
  maxRows?: number;
  testId?: string;
}) {
  const spec = DAY_HISTORY_DOMAINS[domain];
  const week = grain === "week";
  // Ladders and legend copy are DECLARED per grain in the registry; this picks
  // the pair, and never writes a ladder of its own.
  const cellLevel = historyCellLevel(spec, grain);
  const aggregateLevel = historyAggregateLevel(spec, grain);
  const levelLabels = week ? spec.weekLevelLabels : spec.levelLabels;
  // "day"/"week" — the bucket word every count in the copy is measured in.
  const bw = bucketWord(grain);
  const ramp =
    spec.ramp === "activity" ? chartActivityRamp : chartObservationRamp;
  const levelClasses = [ramp.emptyClass, ...ramp.stepClasses];
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [calCell, setCalCell] = useState(CAL_CELL);
  // Hover state is SHARED by both charts, keyed on the day: hovering a
  // calendar day highlights that column in the matrix, hovering a matrix cell
  // echoes onto its calendar day. `hoverRow` is the matrix-only half of the
  // crosshair.
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  // A tapped calendar day opens the day panel (selection, not navigation —
  // the domain ledger stays one link away inside the panel).
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  // A tapped matrix row label opens the complementary group-across-time panel.
  // Day and row selection are mutually exclusive: the panel always answers
  // one clear question.
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  // A filter transition into exactly one visible group borrows row selection
  // only while that group remains the sole choice. A null marker means an
  // explicit row selection, which therefore survives later filter expansion.
  const [autoSelectedRowKey, setAutoSelectedRowKey] = useState<string | null>(
    null
  );
  const [matrixRange, setMatrixRange] = useState<{
    start: string;
    end: string;
  } | null>(null);
  const [focusCell, setFocusCell] = useState<{
    row: number;
    col: number;
  } | null>(null);
  const matrixRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<HTMLDivElement>(null);

  // Leading all-empty weeks are trimmed (the day-fill doctrine at week grain),
  // on the UNFILTERED values so chip toggles never reflow the grid.
  const shownWeeks = useMemo(
    () => activeHistoryWeeks(values, end, weeks, weekStart),
    [values, end, weeks, weekStart]
  );

  // The column keys: days, or week starts. ONE list, read by the matrix, the
  // aggregate half and every index the crosshair and keyboard grid resolve.
  const buckets = useMemo(
    () =>
      historyBuckets(
        dayHistoryStart(end, shownWeeks, weekStart),
        end,
        grain,
        weekStart
      ),
    [end, shownWeeks, weekStart, grain]
  );

  const rows = useMemo(
    () =>
      buildDayHistoryRows({
        days: buckets,
        values,
        groups,
        selected,
        maxRows: expanded ? Number.MAX_SAFE_INTEGER : maxRows,
        cellLevel,
        today,
        grain,
        weekStart,
      }),
    [
      buckets,
      values,
      groups,
      selected,
      maxRows,
      expanded,
      cellLevel,
      today,
      grain,
      weekStart,
    ]
  );

  const calendar = useMemo(
    () =>
      showCalendar && !week
        ? buildDayHistoryCalendar({
            totals: dayTotals(values, selected),
            end,
            weeks: shownWeeks,
            weekStart,
            calendarLevel: aggregateLevel,
            today,
          })
        : null,
    [
      showCalendar,
      week,
      values,
      selected,
      end,
      shownWeeks,
      weekStart,
      aggregateLevel,
      today,
    ]
  );

  // The week-grain twin of the calendar: one row, one cell per week.
  const strip = useMemo(
    () =>
      showCalendar && week
        ? buildDayHistoryStrip({
            totals: dayTotals(values, selected, { grain: "week", weekStart }),
            end,
            weeks: shownWeeks,
            weekStart,
            stripLevel: aggregateLevel,
            today,
          })
        : null,
    [
      showCalendar,
      week,
      values,
      selected,
      end,
      shownWeeks,
      weekStart,
      aggregateLevel,
      today,
    ]
  );

  // Resolve the actual date span visible in the matrix. The calendar shows the
  // whole overview while a phone can show only ~two matrix weeks, so the matrix
  // header states the currently visible span explicitly.
  const updateMatrixRange = useCallback(() => {
    const el = matrixRef.current;
    if (!el) {
      setMatrixRange(null);
      return;
    }
    const bounds = el.getBoundingClientRect();
    const label = el.querySelector<HTMLElement>("[data-matrix-label]");
    const left = bounds.left + (label?.getBoundingClientRect().width ?? 0);
    const cells = [
      ...el.querySelectorAll<HTMLElement>(
        '[data-matrix-row="0"][data-matrix-col]'
      ),
    ];
    const visible = cells.filter((cell) => {
      const rect = cell.getBoundingClientRect();
      return rect.right > left + 1 && rect.left < bounds.right - 1;
    });
    const next =
      visible.length > 0
        ? {
            start: visible[0].dataset.date!,
            end: visible[visible.length - 1].dataset.date!,
          }
        : null;
    setMatrixRange((prev) =>
      prev?.start === next?.start && prev?.end === next?.end ? prev : next
    );
  }, []);

  const scrollMatrixToDay = useCallback(
    (date: string) => {
      const el = matrixRef.current;
      const ci = buckets.indexOf(date);
      if (!el || ci < 0) return;
      const cell = el.querySelector<HTMLElement>(
        `[data-matrix-row="0"][data-matrix-col="${ci}"]`
      );
      const label = el.querySelector<HTMLElement>("[data-matrix-label]");
      if (!cell) return;
      const bounds = el.getBoundingClientRect();
      const labelWidth = label?.getBoundingClientRect().width ?? 0;
      const cellBounds = cell.getBoundingClientRect();
      const visibleCenter =
        bounds.left + labelWidth + (bounds.width - labelWidth) / 2;
      const cellCenter = cellBounds.left + cellBounds.width / 2;
      const max = Math.max(0, el.scrollWidth - el.clientWidth);
      el.scrollLeft = Math.max(
        0,
        Math.min(max, el.scrollLeft + cellCenter - visibleCenter)
      );
      updateMatrixRange();
    },
    [buckets, updateMatrixRange]
  );

  const selectDay = (date: string, revealInMatrix: boolean) => {
    setSelectedDay((prev) => (prev === date ? null : date));
    setSelectedRowKey(null);
    setAutoSelectedRowKey(null);
    setHoverDay(null);
    setHoverRow(null);
    if (revealInMatrix) scrollMatrixToDay(date);
  };

  // Both halves open at the RECENT edge — on a narrow screen the left of the
  // window is old history, and landing there reads as "no data". (The calendar
  // only actually scrolls when the window outgrows the screen — All time.)
  // Keyed on the WINDOW only: a chip toggle or fold expansion must never yank
  // a scroll position the user has chosen.
  useEffect(() => {
    for (const el of [matrixRef.current, calendarRef.current]) {
      if (el) el.scrollLeft = el.scrollWidth;
    }
    requestAnimationFrame(updateMatrixRange);
  }, [buckets.length, updateMatrixRange]);

  useEffect(() => {
    const el = matrixRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateMatrixRange);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    requestAnimationFrame(updateMatrixRange);
    return () => ro.disconnect();
  }, [rows.length, expanded, updateMatrixRange]);

  // A window change (range switch) can strand the selected day outside the new
  // day list; reset during render so children never see a panel for an invisible
  // day. React immediately retries this component with the valid selection.
  if (
    selectedDay &&
    (buckets.length === 0 ||
      selectedDay < buckets[0] ||
      selectedDay > buckets[buckets.length - 1])
  ) {
    setSelectedDay(null);
  }

  // Filtering or folding can remove a selected row from the rendered matrix.
  // Reset during render, like the selected-day guard above, so a hidden row
  // cannot remain selected and reappear later.
  if (selectedRowKey && !rows.some((row) => row.key === selectedRowKey)) {
    setSelectedRowKey(null);
    if (autoSelectedRowKey === selectedRowKey) {
      setAutoSelectedRowKey(null);
    }
  }

  // Keep the single roving tab stop inside the rendered grid. Filtering,
  // folding, or changing the lens can shrink either axis after a keyboard user
  // has moved away from the default cell. This is derived-state repair, not an
  // external synchronization effect, so apply it during render.
  if (focusCell) {
    if (rows.length === 0 || buckets.length === 0) {
      setFocusCell(null);
    } else {
      const row = Math.min(focusCell.row, rows.length - 1);
      const col = Math.min(focusCell.col, buckets.length - 1);
      if (row !== focusCell.row || col !== focusCell.col) {
        setFocusCell({ row, col });
      }
    }
  }

  // Size calendar cells to fill the container when the window is short.
  useEffect(() => {
    const el = calendarRef.current;
    if (!el || !showCalendar) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const avail =
        el.clientWidth -
        parseFloat(cs.paddingLeft) -
        parseFloat(cs.paddingRight) -
        (shownWeeks - 1) * CAL_GAP;
      setCalCell(
        Math.max(
          CAL_CELL,
          Math.min(CAL_CELL_MAX, Math.floor(avail / shownWeeks))
        )
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showCalendar, shownWeeks]);

  const calStep = calCell + CAL_GAP;

  const isOn = (key: string) => selected === null || selected.has(key);
  const clearAutomaticRowSelection = () => {
    if (autoSelectedRowKey === null) return;
    setSelectedRowKey((prev) => (prev === autoSelectedRowKey ? null : prev));
    setAutoSelectedRowKey(null);
  };
  const toggle = (key: string) => {
    const current = new Set(selected ?? groups.map((group) => group.key));
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);

    if (next.size === 1 && current.size !== 1) {
      const onlyKey = next.values().next().value!;
      const alreadyExplicitlySelected =
        selectedRowKey === onlyKey && autoSelectedRowKey === null;
      setSelectedDay(null);
      if (!alreadyExplicitlySelected) {
        setSelectedRowKey(onlyKey);
        setAutoSelectedRowKey(onlyKey);
      }
      setHoverDay(null);
      setHoverRow(null);
      setDetail(null);
    } else if (next.size !== 1) {
      clearAutomaticRowSelection();
    }
  };

  const labelFor = (key: string) =>
    groups.find((g) => g.key === key)?.label ?? key;

  // Chips in RELEVANCY order — window total descending, ties keeping the
  // caller's vocabulary order (the sort is stable) — so a 20-item dose list
  // leads with what is actually taken, not the alphabet.
  const chipGroups = useMemo(() => {
    const totals = new Map<string, number>();
    for (const v of values) {
      if (v.value > 0)
        totals.set(v.group, (totals.get(v.group) ?? 0) + v.value);
    }
    return [...groups].sort(
      (a, b) => (totals.get(b.key) ?? 0) - (totals.get(a.key) ?? 0)
    );
  }, [groups, values]);
  const collapsedChipCount = 5;
  const shownChipGroups =
    filtersExpanded || chipGroups.length <= collapsedChipCount
      ? chipGroups
      : chipGroups.slice(0, collapsedChipCount);
  const selectedCount = selected === null ? groups.length : selected.size;

  // Total of the secondary quantity (workout minutes) over the FILTERED view,
  // for the summary line.
  const totalDetail = useMemo(() => {
    let sum = 0;
    for (const v of values) {
      if (!(v.value > 0)) continue;
      if (selected && !selected.has(v.group)) continue;
      sum += v.detail ?? 0;
    }
    return sum;
  }, [values, selected]);

  // One bucket's NAME, wherever it is spoken: a date at day grain, "week of …"
  // at week grain. A week cell that named only its first day would read as a
  // Sunday with a suspiciously large total.
  const bucketLabel = (bucket: string): string =>
    week
      ? `Week of ${formatLongDate(bucket, formatPrefs, { year: "always" })}`
      : formatLongDate(bucket, formatPrefs, { year: "always" });

  // How much of a bucket the window covers, spoken. Silent for a complete one:
  // the qualifier exists to stop a half-elapsed week reading as a decline, and
  // saying "7 of 7 days" everywhere else would be noise.
  const partialSuffix = (bucket: string): string => {
    if (!week) return "";
    const coverage = historyBucketCoverage(bucket, "week", end);
    return coverage.partial ? ` · ${plural(coverage.days, "day", "days")} so far` : "";
  };

  const matrixCellSummary = (row: DayHistoryRow, ci: number): string => {
    const cell = row.cells[ci];
    const mins =
      cell.detail > 0 && spec.detailSuffix
        ? ` · ${cell.detail} ${spec.detailSuffix}`
        : "";
    const notes = cell.notes.length > 0 ? ` · ${cell.notes.join(", ")}` : "";
    return `${row.label} · ${bucketLabel(cell.date)} — ${plural(
      cell.value,
      spec.unitOne,
      spec.unitMany
    )}${mins}${notes}${partialSuffix(cell.date)}`;
  };

  const minsSuffix =
    spec.detailSuffix === "min" && totalDetail > 0
      ? ` · ${durationLabel(totalDetail)}`
      : "";
  const aggregateTotal = calendar?.totalValue ?? strip?.totalValue ?? null;
  const aggregateActive = calendar?.activeDays ?? strip?.activeWeeks ?? null;
  const summary =
    aggregateTotal != null && aggregateActive != null
      ? `${plural(aggregateTotal, spec.unitOne, spec.unitMany)} over ${plural(
          aggregateActive,
          bw.one,
          bw.many
        )}${minsSuffix}`
      : `${plural(
          rows.reduce((s, r) => s + r.total, 0),
          spec.unitOne,
          spec.unitMany
        )} in this window${minsSuffix}`;

  // The matrix's reserved date header. At day grain it prints a compact date
  // above every week boundary; at week grain every column IS a week, so a date
  // per column would be a wall of numbers — it prints the MONTH name above the
  // week that opens each month instead, the same rule the calendar's overlay
  // uses for its columns.
  const axisLabels = useMemo(() => {
    if (!week) {
      return buckets
        .map((d, index) => ({ index, label: formatMonthDay(d, formatPrefs) }))
        .filter(({ index }) => index % 7 === 0);
    }
    const months = monthNames("short");
    const out: { index: number; label: string }[] = [];
    let prev = -1;
    buckets.forEach((b, index) => {
      const month = Number(b.slice(5, 7)) - 1;
      if (month !== prev) {
        out.push({ index, label: months[month] });
        prev = month;
      }
    });
    return out;
  }, [week, buckets, formatPrefs]);

  // Every boundary is a week boundary at week grain, so the matrix's extra
  // intra-week separator collapses to the plain gap.
  const weekGap = week ? 0 : MTX_WEEK_GAP;

  const selectedMarkerIndex = selectedDay ? buckets.indexOf(selectedDay) : -1;
  const hoverMarkerIndex = hoverDay ? buckets.indexOf(hoverDay) : -1;
  // When hover and selection are close, the hover preview temporarily wins:
  // rendering both labels would make the dates unreadable. The selected marker
  // returns as soon as the pointer/focus leaves.
  const matrixDateMarkers =
    hoverMarkerIndex >= 0
      ? selectedMarkerIndex >= 0 &&
        Math.abs(selectedMarkerIndex - hoverMarkerIndex) > 4
        ? [selectedDay!, hoverDay!]
        : [hoverDay!]
      : selectedMarkerIndex >= 0
        ? [selectedDay!]
        : [];
  const matrixMarkerIndexes = matrixDateMarkers.map((date) =>
    buckets.indexOf(date)
  );
  // Selection borrows the ordinary day-hover emphasis only while no live
  // pointer/focus preview exists. A real hover temporarily takes priority and
  // the selected column returns when it leaves.
  const matrixEmphasisDay =
    hoverDay ??
    (hoverRow === null && selectedRowKey === null ? selectedDay : null);
  const matrixEmphasisRow =
    hoverRow ?? (hoverDay === null ? selectedRowKey : null);
  // A named row adds useful information to the aggregate calendar only when
  // there are peers to distinguish it from. Live row hover wins over the
  // persistent selection, while a calendar-day preview leaves the selected
  // row projection intact.
  const calendarEmphasisRow =
    rows.length > 1
      ? (rows.find((row) => row.key === (hoverRow ?? selectedRowKey)) ?? null)
      : null;
  // A persistent row selection already has a neighboring detail panel, but a
  // click does not end the pointer's live preview. Keep the hover context until
  // the pointer actually leaves; only then return the calendar to its own
  // heading and aggregate instead of repeating the selected-row panel.
  const calendarHeaderRow =
    rows.length > 1 && hoverRow
      ? (rows.find((row) => row.key === hoverRow) ?? null)
      : null;
  const calendarEmphasisCells = new Map(
    calendarEmphasisRow?.cells
      .filter((cell) => cell.value > 0)
      .map((cell) => [cell.date, cell]) ?? []
  );

  // One summary for a cell of the aggregate half at EITHER grain: a calendar
  // day and a strip week answer the same question about different buckets.
  const aggregateCellSummary = (cell: {
    date: string;
    value: number;
    today: boolean;
  }): string => {
    const name = bucketLabel(cell.date);
    const base =
      cell.value === 0
        ? `${name} — no ${spec.unitMany}`
        : `${name} — ${plural(cell.value, spec.unitOne, spec.unitMany)}`;
    const rowCell = calendarEmphasisCells.get(cell.date);
    const rowContext = calendarEmphasisRow
      ? ` · ${calendarEmphasisRow.label}: ${rowCell ? plural(rowCell.value, spec.unitOne, spec.unitMany) : "none"}`
      : "";
    return `${base}${rowContext}${partialSuffix(cell.date)}${
      cell.today ? (week ? " · this week" : " · today") : ""
    }`;
  };

  const calendarCellSummary = (cell: DayHistoryCalendarCell): string =>
    aggregateCellSummary(cell);

  // Hover for pointers, focus for keyboards, tap for touch — `title` never
  // fires on touch, so taps push the same summaries into the caption.
  // Calendar cells drive the shared hover day; a click SELECTS (toggling),
  // never navigates.
  const calendarCellProps = (text: string, date: string) => ({
    title: text,
    onMouseEnter: () => {
      setDetail(text);
      setHoverDay(date);
    },
    onMouseLeave: () => {
      setDetail(null);
      setHoverDay(null);
    },
    onFocus: () => {
      setDetail(text);
      setHoverDay(date);
    },
    onBlur: () => {
      setDetail(null);
      setHoverDay(null);
    },
    onClick: () => {
      setDetail(text);
      selectDay(date, true);
    },
  });

  // The selected BUCKET's items under the CURRENT filter, largest first.
  const dayItems = useMemo(() => {
    if (!selectedDay) return null;
    const agg = new Map<
      string,
      { value: number; detail: number; notes: string[] }
    >();
    for (const v of values) {
      if (historyBucket(v.date, grain, weekStart) !== selectedDay) continue;
      if (!(v.value > 0)) continue;
      if (selected && !selected.has(v.group)) continue;
      const e = agg.get(v.group) ?? { value: 0, detail: 0, notes: [] };
      e.value += v.value;
      e.detail += v.detail ?? 0;
      if (v.note && !e.notes.includes(v.note)) e.notes.push(v.note);
      agg.set(v.group, e);
    }
    return [...agg.entries()]
      .map(([key, e]) => ({
        key,
        meta: groups.find((g) => g.key === key),
        ...e,
      }))
      .sort((a, b) => b.value - a.value);
  }, [selectedDay, values, selected, groups, grain, weekStart]);
  const selectedDayTotal =
    dayItems?.reduce((sum, item) => sum + item.value, 0) ?? 0;
  const selectedDayUnfilteredTotal = selectedDay
    ? values.reduce(
        (sum, item) =>
          historyBucket(item.date, grain, weekStart) === selectedDay &&
          item.value > 0
            ? sum + item.value
            : sum,
        0
      )
    : 0;
  // A week has no single day anchor to scroll to and the Training Log's anchor
  // is a DAY, so at week grain every domain lands on the Timeline filtered to
  // the week — clamped to the window's end, never claiming days that have not
  // happened.
  const bucketFeedHref = (bucket: string): AppRoute =>
    timelineRangeHref(
      bucket,
      historyBucketCoverage(bucket, "week", end).through
    );
  const selectedDayHref = (date: string) =>
    week
      ? bucketFeedHref(date)
      : domain === "workout" && selectedDayTotal > 0
        ? trainingLogDayHref(date)
        : timelineDayHref(date);
  const selectedDayLinkLabel =
    !week && domain === "workout" && selectedDayTotal > 0
      ? "Training log →"
      : "Timeline →";
  const occurrenceHref = (date: string) =>
    week
      ? bucketFeedHref(date)
      : domain === "workout"
        ? trainingLogDayHref(date)
        : timelineDayHref(date);

  const selectedRow = selectedRowKey
    ? (rows.find((row) => row.key === selectedRowKey) ?? null)
    : null;
  const selectedRowDates = selectedRow
    ? selectedRow.cells.filter((cell) => cell.value > 0).toReversed()
    : [];

  const focusMatrixCell = (row: number, col: number) => {
    const nextRow = Math.max(0, Math.min(rows.length - 1, row));
    const nextCol = Math.max(0, Math.min(buckets.length - 1, col));
    setFocusCell({ row: nextRow, col: nextCol });
    matrixRef.current
      ?.querySelector<HTMLElement>(
        `[data-matrix-row="${nextRow}"][data-matrix-col="${nextCol}"]`
      )
      ?.focus();
  };

  // Matrix cells drive both halves of the shared hover state. A single roving
  // tab stop enters the grid; arrows then traverse day/group without adding
  // hundreds of cells to the page's tab order.
  const matrixCellProps = (
    text: string,
    rowKey: string,
    date: string,
    ri: number,
    ci: number
  ) => ({
    title: text,
    onMouseEnter: () => {
      setDetail(text);
      setHoverDay(date);
      setHoverRow(rowKey);
    },
    onMouseLeave: () => {
      setDetail(null);
      setHoverDay(null);
      setHoverRow(null);
    },
    onFocus: () => {
      setFocusCell({ row: ri, col: ci });
      setDetail(text);
      setHoverDay(date);
      setHoverRow(rowKey);
    },
    onBlur: () => {
      setDetail(null);
      setHoverDay(null);
      setHoverRow(null);
    },
    onClick: () => {
      setDetail(text);
      selectDay(date, false);
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
      let next: { row: number; col: number } | null = null;
      if (event.key === "ArrowLeft") next = { row: ri, col: ci - 1 };
      if (event.key === "ArrowRight") next = { row: ri, col: ci + 1 };
      if (event.key === "ArrowUp") next = { row: ri - 1, col: ci };
      if (event.key === "ArrowDown") next = { row: ri + 1, col: ci };
      if (event.key === "Home") next = { row: ri, col: 0 };
      if (event.key === "End") next = { row: ri, col: buckets.length - 1 };
      if (!next) return;
      event.preventDefault();
      focusMatrixCell(next.row, next.col);
    },
  });

  // The aggregate half's heading, summary and legend — identical at both
  // grains, so the strip does not restate them. Only the CELLS fork.
  const aggregateHeader = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3
          id={`${testId}-calendar-title`}
          data-testid={
            calendarHeaderRow ? "day-history-calendar-row-context" : undefined
          }
          aria-live="polite"
          className={`truncate ${PANE_TITLE}`}
        >
          {calendarHeaderRow
            ? `${calendarHeaderRow.label} ${bw.many}`
            : week
              ? spec.weekCalendarTitle
              : spec.calendarTitle}
        </h3>
        <span
          data-testid={
            calendarHeaderRow ? "day-history-calendar-row-summary" : undefined
          }
          className={`mt-0.5 block ${PANE_META}`}
        >
          {calendarHeaderRow
            ? `${plural(
                calendarHeaderRow.total,
                spec.unitOne,
                spec.unitMany
              )} across ${plural(calendarHeaderRow.activeDays, bw.one, bw.many)}`
            : summary}
        </span>
      </div>
      <div className={`mt-0.5 flex items-center gap-3 ${PANE_META}`}>
        <span className="flex items-center gap-1">
          <span className={`h-2.5 w-2.5 rounded-[3px] ${levelClasses[0]}`} />
          No record
          <span
            className={`ml-1 h-2.5 w-2.5 rounded-[3px] ${levelClasses[1]}`}
          />
          {spec.calendarKind === "coverage" ? "Recorded" : "Active"}
        </span>
      </div>
    </div>
  );

  return (
    <div data-testid={testId} className="space-y-4">
      {/* Group filter chips — client state; every builder above re-runs on toggle. */}
      {groups.length > 1 && (
        <div
          role="group"
          aria-label={`Filter ${spec.groupMany}`}
          className="space-y-2"
        >
          <div className="text-xs font-medium text-slate-600 dark:text-slate-300">
            Viewing {selectedCount} of {groups.length} {spec.groupMany}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {shownChipGroups.map((g) => (
              <button
                key={g.key}
                type="button"
                data-testid="day-history-chip"
                data-group={g.key}
                aria-pressed={isOn(g.key)}
                aria-label={g.label}
                title={g.label}
                onClick={() => toggle(g.key)}
                className={`flex min-h-7 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition ${
                  isOn(g.key)
                    ? "border-brand-500 bg-brand-500/10 font-medium text-slate-800 dark:text-slate-100"
                    : "border-black/10 text-slate-500 dark:border-white/15 dark:text-slate-400"
                }`}
              >
                {g.foodSlug && (
                  <FoodGroupIcon
                    slug={g.foodSlug}
                    className={`h-3.5 w-3.5 ${
                      isOn(g.key)
                        ? (FOOD_GROUP_TIER_TINT[g.tier as FoodGroupTier] ?? "")
                        : ""
                    }`}
                  />
                )}
                <span className="max-w-28 truncate">{g.short ?? g.label}</span>
              </button>
            ))}
            {chipGroups.length > collapsedChipCount && (
              <button
                type="button"
                data-testid="day-history-filter-toggle"
                aria-expanded={filtersExpanded}
                onClick={() => setFiltersExpanded((v) => !v)}
                className="min-h-7 rounded-full border border-dashed border-black/15 px-2.5 py-0.5 text-xs font-medium text-brand-700 transition hover:border-brand-500 dark:border-white/20 dark:text-brand-300"
              >
                {filtersExpanded
                  ? "Show less"
                  : `+${chipGroups.length - collapsedChipCount} more`}
              </button>
            )}
            <span className="flex items-center gap-1.5">
              <span
                className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/15"
                aria-hidden="true"
              />
              <button
                type="button"
                disabled={selected === null}
                onClick={() => {
                  setSelected(null);
                  clearAutomaticRowSelection();
                  setDetail(null);
                }}
                className="min-h-7 rounded-full border border-dashed border-black/15 px-2.5 py-0.5 text-xs text-slate-500 transition enabled:hover:border-brand-500 enabled:hover:text-slate-800 disabled:opacity-40 dark:border-white/20 dark:text-slate-400 dark:enabled:hover:text-slate-100"
              >
                All
              </button>
              <button
                type="button"
                disabled={selected !== null && selected.size === 0}
                onClick={() => {
                  setSelected(new Set());
                  clearAutomaticRowSelection();
                  setDetail(null);
                }}
                className="min-h-7 rounded-full border border-dashed border-black/15 px-2.5 py-0.5 text-xs text-slate-500 transition enabled:hover:border-brand-500 enabled:hover:text-slate-800 disabled:opacity-40 dark:border-white/20 dark:text-slate-400 dark:enabled:hover:text-slate-100"
              >
                None
              </button>
            </span>
          </div>
        </div>
      )}

      <div
        data-testid="day-history-calendar-band"
        className={`grid gap-4 ${
          (calendar || strip) && (selectedDay || selectedRow)
            ? "xl:grid-cols-2 xl:items-start"
            : ""
        }`}
      >
        {/* Calendar half: coverage. Labels are OVERLAID on the grid (no gutter
          rows/columns), so the cells themselves get the full width — on a
          phone the window fills the screen edge to edge. */}
        {calendar && (
          <section
            aria-labelledby={`${testId}-calendar-title`}
            data-testid="day-history-calendar-panel"
          >
            {aggregateHeader}
            <div
              ref={calendarRef}
              className={SCROLLER}
              data-testid="day-history-calendar"
            >
              <div className="relative inline-block align-top">
                <div className="flex">
                  {calendar.columns.map((col, ci) => (
                    <div key={ci} className="flex flex-col">
                      {col.map((cell, ri) => {
                        const size = { width: calCell, height: calCell };
                        const hitSize = {
                          // Each real day owns the visual whitespace to its right
                          // and below. The last row/column has no trailing gap.
                          width:
                            ci < calendar.columns.length - 1
                              ? calStep
                              : calCell,
                          height: ri < col.length - 1 ? calStep : calCell,
                        };
                        if (cell.future) {
                          return (
                            <div
                              key={cell.date}
                              style={hitSize}
                              aria-hidden="true"
                            />
                          );
                        }
                        const isSelected = selectedDay === cell.date;
                        const isPreviewed = hoverDay === cell.date;
                        const rowMatch = calendarEmphasisCells.has(cell.date);
                        const rowRecedes =
                          calendarEmphasisRow !== null &&
                          !rowMatch &&
                          !isSelected &&
                          !isPreviewed &&
                          !cell.today;
                        // A matrix hover echoes onto its calendar day.
                        const echo =
                          hoverRow !== null && hoverDay === cell.date;
                        const cls = `relative rounded-[5px] transition-[box-shadow,opacity] duration-150 ease-out motion-reduce:transition-none ${levelClasses[cell.level]}${
                          isSelected
                            ? " ring-2 ring-slate-600 dark:ring-slate-200"
                            : isPreviewed || echo
                              ? " ring-2 ring-slate-600 dark:ring-slate-200"
                              : ""
                        }${rowRecedes ? " opacity-20" : ""}`;
                        return (
                          <button
                            key={cell.date}
                            type="button"
                            data-testid={
                              cell.value > 0 ? "day-history-day" : undefined
                            }
                            data-date={cell.date}
                            data-level={cell.level}
                            data-active={cell.value > 0 ? "true" : "false"}
                            data-row-match={
                              calendarEmphasisRow
                                ? rowMatch
                                  ? "true"
                                  : "false"
                                : undefined
                            }
                            aria-label={calendarCellSummary(cell)}
                            aria-pressed={isSelected}
                            aria-current={cell.today ? "date" : undefined}
                            style={hitSize}
                            className="group grid place-items-start focus:outline-hidden"
                            {...calendarCellProps(
                              calendarCellSummary(cell),
                              cell.date
                            )}
                          >
                            <span
                              aria-hidden="true"
                              style={size}
                              className={`${cls} grid place-items-center group-hover:ring-2 group-hover:ring-slate-600 group-focus:ring-2 group-focus:ring-slate-600 dark:group-hover:ring-slate-200 dark:group-focus:ring-slate-200`}
                            >
                              {(isSelected || isPreviewed || cell.today) && (
                                <span
                                  data-testid="day-history-cell-date"
                                  className={`text-sm font-bold leading-none tabular-nums ${ramp.labelClasses[cell.level]}`}
                                >
                                  {Number(cell.date.slice(8, 10))}
                                </span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
                {calendar.monthLabels.map((m) => (
                  <span
                    key={m.col}
                    aria-hidden="true"
                    className={`${OVERLAY_LABEL} -top-1.5 z-2`}
                    style={{ left: m.col * calStep }}
                  >
                    {m.label}
                  </span>
                ))}
                {calendar.weekdayOrder.map((wd, row) =>
                  row % 2 === 1 ? (
                    <span
                      key={row}
                      aria-hidden="true"
                      className={`${OVERLAY_LABEL} -left-1 z-2`}
                      style={{ top: row * calStep + (calCell - 16) / 2 }}
                    >
                      {DOW[wd]}
                    </span>
                  ) : null
                )}
              </div>
            </div>
          </section>
        )}

        {/* Week strip: the aggregate half at week grain. One row, one cell per
          week — the 7-row day-of-week shape means nothing when every cell IS a
          week, and `ActiveDaysStrip` is the in-app precedent. Month names ride
          above the weeks that open a month, the same overlay the calendar uses
          for its columns. */}
        {strip && (
          <section
            aria-labelledby={`${testId}-calendar-title`}
            data-testid="day-history-strip-panel"
          >
            {aggregateHeader}
            <div
              ref={calendarRef}
              className={SCROLLER}
              data-testid="day-history-strip"
            >
              <div className="relative inline-block align-top pt-3">
                <div className="flex">
                  {strip.cells.map((cell, ci) => {
                    const isSelected = selectedDay === cell.date;
                    const isPreviewed = hoverDay === cell.date;
                    const rowMatch = calendarEmphasisCells.has(cell.date);
                    const rowRecedes =
                      calendarEmphasisRow !== null &&
                      !rowMatch &&
                      !isSelected &&
                      !isPreviewed &&
                      !cell.today;
                    const echo = hoverRow !== null && hoverDay === cell.date;
                    const text = aggregateCellSummary(cell);
                    const cls = `relative rounded-[5px] transition-[box-shadow,opacity] duration-150 ease-out motion-reduce:transition-none ${
                      levelClasses[cell.level]
                    }${
                      isSelected || isPreviewed || echo
                        ? " ring-2 ring-slate-600 dark:ring-slate-200"
                        : ""
                    }${rowRecedes ? " opacity-20" : ""}`;
                    return (
                      <button
                        key={cell.date}
                        type="button"
                        data-testid={
                          cell.value > 0 ? "day-history-week" : undefined
                        }
                        data-date={cell.date}
                        data-level={cell.level}
                        data-active={cell.value > 0 ? "true" : "false"}
                        data-partial={cell.partial ? "true" : undefined}
                        data-row-match={
                          calendarEmphasisRow
                            ? rowMatch
                              ? "true"
                              : "false"
                            : undefined
                        }
                        aria-label={text}
                        aria-pressed={isSelected}
                        aria-current={cell.today ? "date" : undefined}
                        style={{
                          // Each week owns the whitespace to its right, so the
                          // pointer never drops between cells.
                          width:
                            ci < strip.cells.length - 1
                              ? MTX_CELL_W + MTX_GAP
                              : MTX_CELL_W,
                          height: MTX_CELL_H,
                        }}
                        className="group grid place-items-start focus:outline-hidden"
                        {...calendarCellProps(text, cell.date)}
                      >
                        <span
                          aria-hidden="true"
                          style={{ width: MTX_CELL_W, height: MTX_CELL_H }}
                          className={`${cls} block group-hover:ring-2 group-hover:ring-slate-600 group-focus:ring-2 group-focus:ring-slate-600 dark:group-hover:ring-slate-200 dark:group-focus:ring-slate-200`}
                        />
                      </button>
                    );
                  })}
                </div>
                {strip.monthLabels.map((m) => (
                  <span
                    key={m.col}
                    aria-hidden="true"
                    className={`${OVERLAY_LABEL} top-0 z-2`}
                    style={{ left: m.col * (MTX_CELL_W + MTX_GAP) }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Bucket panel: what the SELECTED day or week held, under the current
          filter — selection, not navigation; the domain ledger stays one link
          away. */}
        {selectedDay && dayItems && (
          <div
            data-testid="day-history-daypanel"
            className="min-w-0 border-t border-black/10 px-1 pt-3 text-sm motion-safe:animate-[overlay-fade-in_150ms_ease-out] xl:border-0 xl:pt-0 dark:border-white/10"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3
                  className={PANE_TITLE}
                  data-testid="day-history-panel-title"
                >
                  {bucketLabel(selectedDay)}
                  {selectedDay === historyBucket(today, grain, weekStart)
                    ? week
                      ? " · this week"
                      : " · today"
                    : ""}
                </h3>
                <span className={`mt-0.5 block ${PANE_META}`}>
                  {dayItems.length === 0
                    ? selectedDayUnfilteredTotal > 0
                      ? `Nothing logged this ${bw.one} under the current filters.`
                      : `Nothing logged this ${bw.one}.`
                    : `${plural(selectedDayTotal, spec.unitOne, spec.unitMany)} under the current filters`}
                  {partialSuffix(selectedDay)}
                </span>
              </div>
              <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                {/* "Log for this day" seeds a DATE into the domain's writer.
                    A week is not a date, and seeding its first day would put
                    the entry on a day the reader never picked — so at week
                    grain the offer is withheld rather than guessed (#2413). */}
                {addHref && !week ? (
                  <Link
                    href={dayHistoryAddHref(addHref, domain, selectedDay)}
                    data-testid="day-history-add-link"
                    className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                  >
                    Log for this day →
                  </Link>
                ) : null}
                {spec.dayLink ? (
                  <Link
                    href={spec.dayLink.href(
                      selectedDay,
                      week
                        ? historyBucketCoverage(selectedDay, "week", end)
                            .through
                        : selectedDay
                    )}
                    data-testid="day-history-day-link"
                    className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                  >
                    {spec.dayLink.label} →
                  </Link>
                ) : null}
                <Link
                  href={selectedDayHref(selectedDay)}
                  className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
                >
                  {selectedDayLinkLabel}
                </Link>
                <button
                  type="button"
                  aria-label={`Close ${bw.one} details`}
                  title="Close"
                  onClick={() => setSelectedDay(null)}
                  className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                >
                  ×
                </button>
              </span>
            </div>
            {dayItems.length > 0 && (
              <ul className="mt-2 space-y-1">
                {dayItems.map((item) => (
                  <li
                    key={item.key}
                    data-testid="day-history-day-item"
                    className={`flex items-baseline justify-between gap-3 ${PANE_ROW}`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {item.meta?.foodSlug && (
                        <FoodGroupIcon
                          slug={item.meta.foodSlug}
                          className={`h-3.5 w-3.5 shrink-0 ${
                            FOOD_GROUP_TIER_TINT[
                              item.meta.tier as FoodGroupTier
                            ] ?? ""
                          }`}
                        />
                      )}
                      <span className="truncate">
                        {item.meta?.label ?? item.key}
                      </span>
                    </span>
                    <span className={PANE_VALUE}>
                      {plural(item.value, spec.unitOne, spec.unitMany)}
                      {item.detail > 0 && spec.detailSuffix
                        ? ` · ${item.detail} ${spec.detailSuffix}`
                        : ""}
                      {item.notes.length > 0
                        ? ` · ${item.notes.join(", ")}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Row panel: when a label is selected, turn the horizontal pattern into
          a readable occurrence ledger. Newest first keeps recent history at
          the top; the bounded list prevents a frequent group from taking over
          the page. */}
        {selectedRow && (
          <div
            data-testid="day-history-rowpanel"
            className="min-w-0 w-full max-w-3xl border-t border-black/10 px-1 pt-3 text-sm motion-safe:animate-[overlay-fade-in_150ms_ease-out] xl:max-w-none xl:border-0 xl:pt-0 dark:border-white/10"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className={PANE_TITLE}>{selectedRow.label}</h3>
                <span className={`mt-0.5 block ${PANE_META}`}>
                  {plural(selectedRow.total, spec.unitOne, spec.unitMany)}{" "}
                  across {plural(selectedRow.activeDays, bw.one, bw.many)}
                </span>
              </div>
              <button
                type="button"
                aria-label={`Close ${spec.groupOne} details`}
                title="Close"
                onClick={() => {
                  setSelectedRowKey(null);
                  setAutoSelectedRowKey(null);
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              >
                ×
              </button>
            </div>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
              {selectedRowDates.map((cell) => (
                <li
                  key={cell.date}
                  data-testid="day-history-row-occurrence"
                  className={`flex items-baseline justify-between gap-3 ${PANE_ROW}`}
                >
                  <Link
                    href={occurrenceHref(cell.date)}
                    className="min-w-0 truncate text-xs hover:underline"
                  >
                    <time dateTime={cell.date}>
                      {formatLongDate(cell.date, formatPrefs, {
                        year: "always",
                      })}
                    </time>
                  </Link>
                  <span className={PANE_VALUE}>
                    {plural(cell.value, spec.unitOne, spec.unitMany)}
                    {cell.detail > 0 && spec.detailSuffix
                      ? ` · ${cell.detail} ${spec.detailSuffix}`
                      : ""}
                    {cell.notes.length > 0 ? ` · ${cell.notes.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <p className="sr-only" aria-live="polite">
        {selectedDay
          ? `${bucketLabel(selectedDay)} selected. ${plural(
              selectedDayTotal,
              spec.unitOne,
              spec.unitMany
            )} under the current filters.`
          : selectedRow
            ? `${selectedRow.label} selected. ${plural(
                selectedRow.total,
                spec.unitOne,
                spec.unitMany
              )} across ${plural(selectedRow.activeDays, bw.one, bw.many)}.`
            : ""}
      </p>

      {/* Matrix half: composition — one row per group, one cell per day, an
          extra gap at each week boundary so the weekly rhythm reads. */}
      {rows.length > 0 && (
        <section aria-labelledby={`${testId}-matrix-title`}>
          <div
            data-testid="day-history-matrix-header"
            className="mb-1 flex items-center justify-between gap-3"
          >
            <h3 id={`${testId}-matrix-title`} className="sr-only">
              {spec.matrixTitle}
            </h3>
            <span
              data-testid={detail ? "day-history-detail" : undefined}
              aria-live="polite"
              title={detail ?? undefined}
              className={`min-w-0 truncate text-xs ${
                detail
                  ? "text-slate-500 dark:text-slate-400"
                  : "font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300"
              }`}
            >
              {detail ?? spec.matrixTitle}
            </span>
            <div className="flex shrink-0 items-center gap-3">
              {matrixRange && (
                <span
                  data-testid="day-history-visible-range"
                  className="text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400"
                >
                  {formatMonthDay(matrixRange.start, formatPrefs)}–
                  {formatMonthDay(matrixRange.end, formatPrefs)}
                </span>
              )}
              <span
                data-testid="day-history-scale"
                className="flex items-center gap-1.5 text-[10px] text-slate-500 dark:text-slate-400"
                aria-label={`Cell scale: ${levelLabels.join(", ")} ${spec.unitMany}${
                  week ? " a week" : ""
                }`}
              >
                {levelClasses.map((c, i) => (
                  <span key={i} className="flex items-center gap-0.5">
                    <span className={`h-[11px] w-[11px] rounded-[2px] ${c}`} />
                    <span>{levelLabels[i]}</span>
                  </span>
                ))}
                <span>{spec.unitMany}</span>
              </span>
            </div>
          </div>
          <div
            ref={matrixRef}
            className={SCROLLER}
            data-testid="day-history-matrix"
            onScroll={updateMatrixRange}
            onMouseLeave={() => {
              setHoverDay(null);
              setHoverRow(null);
            }}
          >
            <div className="relative min-w-max pr-6 [--day-history-label-w:6rem] sm:[--day-history-label-w:7rem]">
              {/* A real reserved date header: labels no longer cover the top row's
                cells, and month names keep an independently scrolled matrix
                unambiguous. */}
              <div className="relative h-6" aria-hidden="true">
                <span
                  className={`sticky left-0 z-[3] block h-full w-24 backdrop-blur-[2px] sm:w-28 ${MATRIX_LABEL_FADE}`}
                />
                {axisLabels.map(({ index: i, label }) =>
                  matrixMarkerIndexes.some(
                    (markerIndex) => Math.abs(markerIndex - i) <= 4
                  ) ? null : (
                    <span
                      key={buckets[i]}
                      data-testid="day-history-week-label"
                      data-date={buckets[i]}
                      className="absolute top-0 z-[1] whitespace-nowrap text-[11px] font-medium tabular-nums text-slate-500 dark:text-slate-400"
                      style={{
                        left: `calc(var(--day-history-label-w) + ${
                          i * MTX_STEP + Math.floor(i / 7) * weekGap
                        }px)`,
                      }}
                    >
                      {label}
                    </span>
                  )
                )}
                {matrixDateMarkers.map((date) => {
                  const i = buckets.indexOf(date);
                  return (
                    <span
                      key={date}
                      data-testid="day-history-date-marker"
                      data-date={date}
                      className="absolute top-0 z-2 whitespace-nowrap rounded-sm bg-white px-0.5 text-[11px] font-semibold tabular-nums text-slate-800 shadow-sm dark:bg-ink-950 dark:text-slate-100"
                      style={{
                        left: `calc(var(--day-history-label-w) + ${
                          i * MTX_STEP + Math.floor(i / 7) * weekGap
                        }px)`,
                        transform: `translateX(calc(-50% + ${MTX_CELL_W / 2}px))`,
                      }}
                    >
                      {week ? `Wk ${formatMonthDay(date, formatPrefs)}` : formatMonthDay(date, formatPrefs)}
                    </span>
                  );
                })}
              </div>
              <div
                role="grid"
                aria-label={`${spec.matrixTitle}, one column per ${bw.one}`}
                aria-rowcount={rows.length}
                aria-colcount={buckets.length}
                className="flex flex-col"
              >
                {rows.map((row, ri) => {
                  const isFold = row.key === FOLDED_ROW_KEY;
                  // With a single row the crosshair says nothing — the row IS the
                  // matrix — so only the hovered-cell ring survives.
                  const crosshair = rows.length > 1;
                  const labelInner = (
                    <>
                      {row.foodSlug && (
                        <FoodGroupIcon
                          slug={row.foodSlug}
                          className={`h-3.5 w-3.5 shrink-0 ${
                            FOOD_GROUP_TIER_TINT[row.tier as FoodGroupTier] ??
                            ""
                          }`}
                        />
                      )}
                      <span className="truncate">{row.short}</span>
                    </>
                  );
                  const rowSummary = `${row.label}: ${plural(
                    row.total,
                    spec.unitOne,
                    spec.unitMany
                  )} across ${plural(row.activeDays, bw.one, bw.many)}`;
                  const rowHoverProps = {
                    onMouseEnter: () => {
                      setDetail(rowSummary);
                      setHoverDay(null);
                      setHoverRow(row.key);
                    },
                    onMouseLeave: () => {
                      setDetail(null);
                      setHoverRow(null);
                    },
                  };
                  return (
                    <div
                      key={row.key}
                      role="row"
                      data-testid="day-history-row"
                      data-group={row.key}
                      className={`flex min-w-full items-center rounded-[4px] transition-colors duration-150 motion-reduce:transition-none${
                        crosshair && matrixEmphasisRow === row.key
                          ? " bg-slate-500/10 dark:bg-white/10"
                          : ""
                      }`}
                    >
                      {isFold ? (
                        // The fold row is an AFFORDANCE: tapping it expands the
                        // matrix to every group.
                        <button
                          type="button"
                          data-testid="day-history-expand"
                          onClick={() => setExpanded(true)}
                          title={row.foldedKeys.map(labelFor).join(", ")}
                          data-matrix-label
                          aria-label={`${row.label}; expand ${row.foldedKeys.map(labelFor).join(", ")}`}
                          className={`sticky left-0 z-2 flex w-24 shrink-0 cursor-pointer items-center justify-end gap-1 self-stretch px-3 text-xs font-medium text-brand-700 backdrop-blur-[2px] hover:font-semibold sm:w-28 dark:text-brand-400 ${MATRIX_LABEL_FADE}`}
                          {...rowHoverProps}
                          onFocus={() => {
                            setDetail(rowSummary);
                            setHoverDay(null);
                            setHoverRow(row.key);
                          }}
                          onBlur={() => {
                            setDetail(null);
                            setHoverRow(null);
                          }}
                        >
                          {labelInner}
                        </button>
                      ) : (
                        <span
                          role="rowheader"
                          data-matrix-label
                          aria-label={rowSummary}
                          className={`sticky left-0 z-2 flex w-24 shrink-0 cursor-pointer items-center justify-end self-stretch px-3 text-xs text-slate-600 backdrop-blur-[2px] transition-colors hover:text-slate-900 sm:w-28 dark:text-slate-300 dark:hover:text-slate-100 ${MATRIX_LABEL_FADE}`}
                          title={row.label}
                          {...rowHoverProps}
                        >
                          <button
                            type="button"
                            aria-label={`View occurrences for ${row.label}`}
                            aria-pressed={selectedRowKey === row.key}
                            onClick={() => {
                              setSelectedDay(null);
                              setAutoSelectedRowKey(null);
                              setSelectedRowKey((prev) =>
                                prev === row.key ? null : row.key
                              );
                              setDetail(rowSummary);
                            }}
                            onFocus={() => {
                              setDetail(rowSummary);
                              setHoverDay(null);
                              setHoverRow(row.key);
                            }}
                            onBlur={() => {
                              setDetail(null);
                              setHoverRow(null);
                            }}
                            className={`flex h-full min-w-0 flex-1 cursor-pointer items-center justify-end gap-1 text-right hover:font-semibold focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-slate-600 dark:focus-visible:ring-slate-200 ${
                              selectedRowKey === row.key ? "font-semibold" : ""
                            }`}
                          >
                            {labelInner}
                          </button>
                        </span>
                      )}
                      <span className="flex pr-1" role="presentation">
                        {row.cells.map((cell, ci) => {
                          const isHovered =
                            hoverRow === row.key && hoverDay === cell.date;
                          // The cross spans the hovered matrix row AND the hovered
                          // day — whichever chart the day hover came from.
                          const inCross =
                            (matrixEmphasisRow !== null &&
                              matrixEmphasisRow === row.key) ||
                            matrixEmphasisDay === cell.date;
                          const ring = isHovered
                            ? " ring-2 ring-slate-600 dark:ring-slate-200"
                            : !crosshair && matrixEmphasisDay === cell.date
                              ? " ring-2 ring-slate-400 dark:ring-slate-400"
                              : "";
                          const dim =
                            crosshair &&
                            (matrixEmphasisDay !== null ||
                              matrixEmphasisRow !== null) &&
                            !inCross
                              ? " opacity-40"
                              : "";
                          return (
                            <button
                              key={cell.date}
                              type="button"
                              role="gridcell"
                              data-date={cell.date}
                              data-matrix-row={ri}
                              data-matrix-col={ci}
                              aria-label={matrixCellSummary(row, ci)}
                              aria-selected={selectedDay === cell.date}
                              aria-current={cell.today ? "date" : undefined}
                              tabIndex={
                                focusCell
                                  ? focusCell.row === ri && focusCell.col === ci
                                    ? 0
                                    : -1
                                  : ri === 0 && ci === buckets.length - 1
                                    ? 0
                                    : -1
                              }
                              style={{
                                // The transparent remainder owns the visual gap,
                                // so crossing whitespace never drops the active
                                // row/column. A week separator belongs to the
                                // preceding cell by the same rule.
                                width:
                                  MTX_STEP +
                                  ((ci + 1) % 7 === 0 &&
                                  ci < row.cells.length - 1
                                    ? weekGap
                                    : 0),
                                height: MTX_CELL_H + MTX_ROW_GAP,
                              }}
                              className="group relative grid shrink-0 items-center justify-items-start focus:outline-hidden"
                              {...matrixCellProps(
                                matrixCellSummary(row, ci),
                                row.key,
                                cell.date,
                                ri,
                                ci
                              )}
                            >
                              <span
                                aria-hidden="true"
                                style={{
                                  width: MTX_CELL_W,
                                  height: MTX_CELL_H,
                                }}
                                className={`relative block rounded-[4px] transition-[opacity,box-shadow] duration-150 ease-out group-focus:ring-2 group-focus:ring-slate-700 motion-reduce:transition-none dark:group-focus:ring-slate-200 ${levelClasses[cell.level]}${ring}${dim}`}
                              />
                            </button>
                          );
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
      )}
      {expanded && (
        <button
          type="button"
          data-testid="day-history-collapse"
          onClick={() => setExpanded(false)}
          className="text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}
