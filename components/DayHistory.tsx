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

// Single-letter weekday labels indexed by 0=Sun … 6=Sat.
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

// Color bucket per level, from the ONE blessed activity ramp (#1445).
const LEVEL_CLASS = [
  chartActivityRamp.emptyClass,
  ...chartActivityRamp.stepClasses,
];

// Today's cells carry a persistent sky ring — a shape distinct from the brand
// hover/focus ring, and echoed in the legend so it is never color-alone.
const TODAY_RING = "ring-2 ring-sky-500 dark:ring-sky-400";

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// The generalized group×day history (calendar + matrix) — the client half of
// lib/day-history.ts. One component, two domains (food, workout); the domain
// key selects the DECLARED level/wording policy client-side, because the group
// filter chips re-run the pure builders on every toggle and a function can
// never cross the server→client prop boundary.
export default function DayHistory({
  domain,
  values,
  groups,
  end,
  weeks,
  weekStart,
  today,
  showCalendar = true,
  extraDates,
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
  extraDates?: string[]; // overlay dates (confirmed doses)
  maxRows?: number;
  testId?: string;
}) {
  const spec = DAY_HISTORY_DOMAINS[domain];
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const matrixRef = useRef<HTMLDivElement>(null);

  const days = useMemo(
    () => historyDays(dayHistoryStart(end, weeks, weekStart), end),
    [end, weeks, weekStart]
  );

  const extraByDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of extraDates ?? []) m.set(d, (m.get(d) ?? 0) + 1);
    return m;
  }, [extraDates]);

  const rows = useMemo(
    () =>
      buildDayHistoryRows({
        days,
        values,
        groups,
        selected,
        maxRows,
        cellLevel: spec.cellLevel,
        today,
      }),
    [days, values, groups, selected, maxRows, spec, today]
  );

  const calendar = useMemo(
    () =>
      showCalendar
        ? buildDayHistoryCalendar({
            totals: dayTotals(values, selected),
            extraByDate,
            end,
            weeks,
            weekStart,
            calendarLevel: spec.calendarLevel,
            today,
          })
        : null,
    [
      showCalendar,
      values,
      selected,
      extraByDate,
      end,
      weeks,
      weekStart,
      spec,
      today,
    ]
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
    const extra =
      cell.extra > 0 && spec.extraOne && spec.extraMany
        ? ` · ${plural(cell.extra, spec.extraOne, spec.extraMany)}`
        : "";
    return `${base}${extra}${cell.today ? " · today" : ""}`;
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
      )}${
        calendar.totalExtra > 0 && spec.extraMany
          ? ` · ${plural(calendar.totalExtra, spec.extraOne!, spec.extraMany)}`
          : ""
      }`
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

      {/* Calendar half: coverage. */}
      {calendar && (
        <div className="overflow-x-auto" data-testid="day-history-calendar">
          <div className="inline-block min-w-full">
            <div className="flex pl-6 text-[10px] text-slate-500 dark:text-slate-400">
              <div className="flex gap-[3px]">
                {calendar.columns.map((_, col) => {
                  const label = calendar.monthLabels.find((m) => m.col === col);
                  return (
                    <div key={col} className="w-[14px] shrink-0">
                      {label ? label.label : ""}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex">
              <div className="mr-1 flex flex-col gap-[3px] pt-[1px] text-[10px] text-slate-500 dark:text-slate-400">
                {calendar.weekdayOrder.map((wd, row) => (
                  <div
                    key={row}
                    className="flex h-[14px] w-4 items-center justify-end"
                  >
                    {row % 2 === 1 ? DOW[wd] : ""}
                  </div>
                ))}
              </div>
              <div className="flex gap-[3px]">
                {calendar.columns.map((col, ci) => (
                  <div key={ci} className="flex flex-col gap-[3px]">
                    {col.map((cell) => {
                      if (cell.future) {
                        return (
                          <div
                            key={cell.date}
                            className="h-[14px] w-[14px]"
                            aria-hidden="true"
                          />
                        );
                      }
                      const cls = `relative h-[14px] w-[14px] rounded-[3px] ${
                        LEVEL_CLASS[cell.level]
                      }${cell.today ? ` ${TODAY_RING}` : ""}`;
                      const dot = cell.extra > 0 && (
                        <span
                          className="absolute bottom-[2px] left-1/2 h-[3px] w-[3px] -translate-x-1/2 rounded-full bg-sky-600 dark:bg-sky-300"
                          aria-hidden="true"
                        />
                      );
                      const common = hoverProps(calendarCellSummary(cell));
                      if (cell.value > 0 || cell.extra > 0) {
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
                          >
                            {dot}
                          </Link>
                        );
                      }
                      return (
                        <div
                          key={cell.date}
                          data-date={cell.date}
                          aria-label={calendarCellSummary(cell)}
                          className={cls}
                          {...common}
                        >
                          {dot}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Matrix half: composition — one row per group, one cell per day. */}
      {rows.length > 0 && (
        <div
          ref={matrixRef}
          className="overflow-x-auto"
          data-testid="day-history-matrix"
        >
          <div className="min-w-max space-y-[3px]">
            {rows.map((row) => (
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
                <span
                  className="sticky left-0 z-[1] flex w-28 shrink-0 items-center justify-end gap-1 self-stretch bg-white/90 pr-2 text-xs text-slate-600 backdrop-blur-sm dark:bg-ink-800/90 dark:text-slate-300"
                  title={
                    row.key === FOLDED_ROW_KEY
                      ? row.foldedKeys.map(labelFor).join(", ")
                      : row.label
                  }
                >
                  {row.foodSlug && (
                    <FoodGroupIcon
                      slug={row.foodSlug}
                      className={`h-3.5 w-3.5 shrink-0 ${
                        FOOD_GROUP_TIER_TINT[row.tier as FoodGroupTier] ?? ""
                      }`}
                    />
                  )}
                  <span className="truncate">{row.label}</span>
                </span>
                <span className="flex gap-[2px] pr-1" aria-hidden="true">
                  {row.cells.map((cell, ci) => (
                    <span
                      key={cell.date}
                      data-date={cell.date}
                      className={`h-[22px] w-[13px] rounded-[3px] ${
                        LEVEL_CLASS[cell.level]
                      }${cell.today ? ` ${TODAY_RING}` : ""}`}
                      {...hoverProps(matrixCellSummary(row, ci))}
                    />
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
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
          {showCalendar && spec.extraMany && (
            <span className="flex items-center gap-1">
              <span className="h-[5px] w-[5px] rounded-full bg-sky-600 dark:bg-sky-300" />
              {spec.extraMany}
            </span>
          )}
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
