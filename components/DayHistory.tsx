"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { chartActivityRamp } from "@/lib/chart-colors";
import { timelineDayHref } from "@/lib/hrefs";
import {
  DAY_HISTORY_DOMAINS,
  FOLDED_ROW_KEY,
  buildDayHistoryCalendar,
  buildDayHistoryRows,
  dayHistoryStart,
  dayTotals,
  historyDays,
  type DayHistoryCalendarCell,
  type DayHistoryDomainKey,
  type DayHistoryGroupMeta,
  type DayHistoryRow,
  type DayHistoryValue,
} from "@/lib/day-history";
import type { FoodGroupTier } from "@/lib/food-groups";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";

// Three-letter weekday labels indexed by 0=Sun … 6=Sat, overlaid on the grid.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Calendar cell geometry, shared by the cells and the overlaid label offsets.
const CAL_CELL = 24;
const CAL_GAP = 3;
const CAL_STEP = CAL_CELL + CAL_GAP;

// The overlaid month/weekday labels: all-caps pills floating ON the grid (no
// reserved gutter rows/columns — the cells get the full width), kept legible
// over any ramp step by a translucent blurred backing, and click-through so
// the cells beneath keep their hover and links.
const OVERLAY_LABEL =
  "pointer-events-none absolute z-[2] rounded bg-white/70 px-1 text-xs font-semibold uppercase tracking-wide text-slate-700 backdrop-blur-[2px] dark:bg-ink-950/60 dark:text-slate-200";

// Color bucket per level, from the ONE blessed activity ramp (#1445).
const LEVEL_CLASS = [
  chartActivityRamp.emptyClass,
  ...chartActivityRamp.stepClasses,
];

// Today's cells carry a persistent sky ring — a shape distinct from the brand
// hover/focus ring, and echoed in the legend so it is never color-alone.
const TODAY_RING = "ring-2 ring-sky-500 dark:ring-sky-400";

// The horizontal scroll wrapper both halves share. The rendered surface bleeds
// EDGE TO EDGE on phones (the shell pads 1rem, matched here by the negative
// margin) and keeps a few px of padding at every size so the today ring — a
// box-shadow, clipped by overflow otherwise — has room at the container edges.
const SCROLLER = "overflow-x-auto pb-1 pt-2 -mx-4 px-4 sm:-mx-1 sm:px-1";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The generalized group×day history (calendar + matrix) — the client half of
// lib/day-history.ts. One component, three domains (food, workout, dose); the
// domain key selects the DECLARED level/wording policy client-side, because
// the group filter chips re-run the pure builders on every toggle and a
// function can never cross the server→client prop boundary.
export default function DayHistory({
  domain,
  values,
  groups,
  end,
  weeks,
  weekStart,
  today,
  showCalendar = true,
  maxRows = 8,
  testId = "day-history",
}: {
  domain: DayHistoryDomainKey;
  values: DayHistoryValue[];
  // Vocabulary order (catalog order for food); only groups with data.
  groups: DayHistoryGroupMeta[];
  end: string; // the window's last day (never future)
  weeks: number; // week columns, from the lens's clamped caps
  weekStart: number;
  today: string;
  showCalendar?: boolean;
  maxRows?: number;
  testId?: string;
}) {
  const spec = DAY_HISTORY_DOMAINS[domain];
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const matrixRef = useRef<HTMLDivElement>(null);

  const days = useMemo(
    () => historyDays(dayHistoryStart(end, weeks, weekStart), end),
    [end, weeks, weekStart]
  );

  const rows = useMemo(
    () =>
      buildDayHistoryRows({
        days,
        values,
        groups,
        selected,
        maxRows: expanded ? Number.MAX_SAFE_INTEGER : maxRows,
        cellLevel: spec.cellLevel,
        today,
      }),
    [days, values, groups, selected, maxRows, expanded, spec, today]
  );

  const calendar = useMemo(
    () =>
      showCalendar
        ? buildDayHistoryCalendar({
            totals: dayTotals(values, selected),
            end,
            weeks,
            weekStart,
            calendarLevel: spec.calendarLevel,
            today,
          })
        : null,
    [showCalendar, values, selected, end, weeks, weekStart, spec, today]
  );

  // The matrix opens at the RECENT edge — on a narrow screen the left of the
  // window is old history, and landing there reads as "no data".
  useEffect(() => {
    const el = matrixRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [rows.length, days.length]);

  const isOn = (key: string) => selected === null || selected.has(key);
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev ?? groups.map((g) => g.key));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const labelFor = (key: string) =>
    groups.find((g) => g.key === key)?.label ?? key;

  const calendarCellSummary = (cell: DayHistoryCalendarCell): string => {
    const base =
      cell.value === 0
        ? `${cell.date} — no ${spec.unitMany}`
        : `${cell.date} — ${plural(cell.value, spec.unitOne, spec.unitMany)}`;
    return `${base}${cell.today ? " · today" : ""}`;
  };

  const matrixCellSummary = (row: DayHistoryRow, ci: number): string => {
    const cell = row.cells[ci];
    const mins =
      cell.detail > 0 && spec.detailSuffix
        ? ` · ${cell.detail} ${spec.detailSuffix}`
        : "";
    return `${row.label} · ${cell.date} — ${plural(
      cell.value,
      spec.unitOne,
      spec.unitMany
    )}${mins}`;
  };

  const summary = calendar
    ? `${plural(calendar.totalValue, spec.unitOne, spec.unitMany)} over ${plural(
        calendar.activeDays,
        "day",
        "days"
      )}`
    : `${plural(
        rows.reduce((s, r) => s + r.total, 0),
        spec.unitOne,
        spec.unitMany
      )} in this window`;

  const hoverProps = (text: string) => ({
    title: text,
    onMouseEnter: () => setDetail(text),
    onMouseLeave: () => setDetail(null),
    onFocus: () => setDetail(text),
    onBlur: () => setDetail(null),
  });

  return (
    <div data-testid={testId} className="space-y-4">
      {/* Group filter chips — client state; every builder above re-runs on toggle. */}
      {groups.length > 1 && (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="Filter groups"
        >
          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              data-testid="day-history-chip"
              data-group={g.key}
              aria-pressed={isOn(g.key)}
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
              {g.label}
            </button>
          ))}
          <button
            type="button"
            className="px-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            onClick={() => setSelected(null)}
          >
            all
          </button>
          <button
            type="button"
            className="px-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
            onClick={() => setSelected(new Set())}
          >
            none
          </button>
        </div>
      )}

      {/* Calendar half: coverage. Labels are OVERLAID on the grid (no gutter
          rows/columns), so the cells themselves get the full width — on a
          phone the 13-week window fills the screen edge to edge. */}
      {calendar && (
        <div className={SCROLLER} data-testid="day-history-calendar">
          <div className="relative inline-block align-top">
            <div className="flex gap-[3px]">
              {calendar.columns.map((col, ci) => (
                <div key={ci} className="flex flex-col gap-[3px]">
                  {col.map((cell) => {
                    if (cell.future) {
                      return (
                        <div
                          key={cell.date}
                          className="h-6 w-6"
                          aria-hidden="true"
                        />
                      );
                    }
                    const cls = `h-6 w-6 rounded-[5px] ${
                      LEVEL_CLASS[cell.level]
                    }${cell.today ? ` ${TODAY_RING}` : ""}`;
                    const common = hoverProps(calendarCellSummary(cell));
                    if (cell.value > 0) {
                      return (
                        <Link
                          key={cell.date}
                          href={timelineDayHref(cell.date)}
                          data-testid="day-history-day"
                          data-date={cell.date}
                          data-level={cell.level}
                          aria-label={calendarCellSummary(cell)}
                          className={`${cls} block ring-brand-400 hover:ring-2 focus:outline-none focus:ring-2`}
                          {...common}
                        />
                      );
                    }
                    return (
                      <div
                        key={cell.date}
                        data-date={cell.date}
                        aria-label={calendarCellSummary(cell)}
                        className={cls}
                        {...common}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {calendar.monthLabels.map((m) => (
              <span
                key={m.col}
                aria-hidden="true"
                className={`${OVERLAY_LABEL} -top-1.5`}
                style={{ left: m.col * CAL_STEP }}
              >
                {m.label}
              </span>
            ))}
            {calendar.weekdayOrder.map((wd, row) =>
              row % 2 === 1 ? (
                <span
                  key={row}
                  aria-hidden="true"
                  className={`${OVERLAY_LABEL} -left-1`}
                  style={{ top: row * CAL_STEP + (CAL_CELL - 16) / 2 }}
                >
                  {DOW[wd]}
                </span>
              ) : null
            )}
          </div>
        </div>
      )}

      {/* Matrix half: composition — one row per group, one cell per day. */}
      {rows.length > 0 && (
        <div
          ref={matrixRef}
          className={SCROLLER}
          data-testid="day-history-matrix"
        >
          <div className="min-w-max space-y-[3px]">
            {rows.map((row) => {
              const isFold = row.key === FOLDED_ROW_KEY;
              const labelInner = (
                <>
                  {row.foodSlug && (
                    <FoodGroupIcon
                      slug={row.foodSlug}
                      className={`h-3.5 w-3.5 shrink-0 ${
                        FOOD_GROUP_TIER_TINT[row.tier as FoodGroupTier] ?? ""
                      }`}
                    />
                  )}
                  <span className="truncate">{row.label}</span>
                </>
              );
              return (
                <div
                  key={row.key}
                  data-testid="day-history-row"
                  data-group={row.key}
                  className="flex min-w-full items-center"
                  aria-label={`${row.label}: ${plural(
                    row.total,
                    spec.unitOne,
                    spec.unitMany
                  )} across ${plural(row.activeDays, "day", "days")}`}
                >
                  {isFold ? (
                    // The fold row is an AFFORDANCE: tapping it expands the
                    // matrix to every group.
                    <button
                      type="button"
                      data-testid="day-history-expand"
                      onClick={() => setExpanded(true)}
                      title={row.foldedKeys.map(labelFor).join(", ")}
                      className="sticky left-0 z-[1] flex w-28 shrink-0 items-center justify-end gap-1 self-stretch bg-white/70 pr-2 text-xs font-medium text-brand-700 backdrop-blur-sm hover:underline dark:bg-ink-950/70 dark:text-brand-400"
                    >
                      {labelInner}
                    </button>
                  ) : (
                    <span
                      className="sticky left-0 z-[1] flex w-28 shrink-0 items-center justify-end gap-1 self-stretch bg-white/70 pr-2 text-xs text-slate-600 backdrop-blur-sm dark:bg-ink-950/70 dark:text-slate-300"
                      title={row.label}
                    >
                      {labelInner}
                    </span>
                  )}
                  <span className="flex gap-[2px] pr-1" aria-hidden="true">
                    {row.cells.map((cell, ci) => (
                      <span
                        key={cell.date}
                        data-date={cell.date}
                        className={`h-[26px] w-[18px] rounded-[4px] ${
                          LEVEL_CLASS[cell.level]
                        }${cell.today ? ` ${TODAY_RING}` : ""}`}
                        {...hoverProps(matrixCellSummary(row, ci))}
                      />
                    ))}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
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

      {/* Detail caption + legend. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          data-testid="day-history-detail"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {detail ?? summary}
        </p>
        <div className="flex items-center gap-2 text-[10px] text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1">
            <span>Less</span>
            {LEVEL_CLASS.map((c, i) => (
              <span
                key={i}
                className={`h-[11px] w-[11px] rounded-[2px] ${c}`}
              />
            ))}
            <span>More</span>
          </span>
          <span className="flex items-center gap-1">
            <span
              className={`h-[9px] w-[9px] rounded-[2px] ${chartActivityRamp.emptyClass} ${TODAY_RING}`}
            />
            today
          </span>
        </div>
      </div>
    </div>
  );
}
