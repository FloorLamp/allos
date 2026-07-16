"use client";

import { useState } from "react";
import Link from "next/link";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import {
  dateStrInTz,
  isoDate,
  monthGridCells,
  monthNames,
  weekdayOrder,
} from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useWeekStart } from "@/components/WeekStartProvider";

// Single-letter weekday labels indexed by 0=Sun … 6=Sat.
const DOW = ["S", "M", "T", "W", "T", "F", "S"];
// The sidebar is narrow, so the month dropdown uses short labels ("Jan" … "Dec").
const MONTHS = monthNames("short");

export default function JournalCalendar({
  activeDates,
}: {
  activeDates: string[];
}) {
  const active = new Set(activeDates);
  // Match the rest of the app's notion of "today" (the configured app timezone, as
  // used by lib/db `today()`), so the circled day lines up with logged-today entries.
  const todayStr = dateStrInTz(useTimezone());
  const [ty, tm] = todayStr.split("-").map(Number);
  // The profile's first day of the week (0=Sun … 6=Sat); reorders the header and
  // grid so each row starts on that day.
  const weekStart = useWeekStart();
  const dowOrder = weekdayOrder(weekStart);

  // Navigation is bounded: back to January of the earliest year with logged
  // activity, and forward to the current month (or the latest logged activity,
  // if one is somehow dated ahead of today). Month indices are y*12 + m.
  let minAct = Infinity;
  let maxAct = -Infinity;
  for (const d of activeDates) {
    const [y, m] = d.split("-").map(Number);
    const idx = y * 12 + (m - 1);
    if (idx < minAct) minAct = idx;
    if (idx > maxAct) maxAct = idx;
  }
  const nowIdx = ty * 12 + (tm - 1);
  // Earliest navigable year: January of the earliest activity year, but never
  // later than the current year — today must always be reachable, even if the
  // only logged activity is (somehow) dated in the future.
  const minYear =
    minAct === Infinity ? ty : Math.min(ty, Math.floor(minAct / 12));
  const minIdx = minYear * 12;
  const maxIdx = Math.max(nowIdx, maxAct === -Infinity ? nowIdx : maxAct);
  const maxYear = Math.floor(maxIdx / 12);
  const years = Array.from(
    { length: maxYear - minYear + 1 },
    (_, i) => maxYear - i
  );

  const [cursor, setCursor] = useState({ y: ty, m: tm - 1 });

  const cursorIdx = cursor.y * 12 + cursor.m;
  const atMin = cursorIdx <= minIdx;
  const atMax = cursorIdx >= maxIdx;
  // Clamp a target month index into the allowed [minIdx, maxIdx] window.
  const clampTo = (idx: number) => {
    const c = Math.min(maxIdx, Math.max(minIdx, idx));
    return { y: Math.floor(c / 12), m: c % 12 };
  };

  const cells = monthGridCells(cursor.y, cursor.m, weekStart);

  function shift(delta: number) {
    setCursor((c) => clampTo(c.y * 12 + c.m + delta));
  }

  return (
    <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="mb-2 flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={() => shift(-1)}
          disabled={atMin}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
          aria-label="Previous month"
        >
          <IconChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 items-center gap-0.5">
          <select
            value={cursor.m}
            onChange={(e) =>
              setCursor((c) => clampTo(c.y * 12 + Number(e.target.value)))
            }
            aria-label="Month"
            className="select-bare pl-0.5 text-xs"
          >
            {MONTHS.map((label, m) => {
              const idx = cursor.y * 12 + m;
              return (
                <option
                  key={m}
                  value={m}
                  disabled={idx < minIdx || idx > maxIdx}
                >
                  {label}
                </option>
              );
            })}
          </select>
          <select
            value={cursor.y}
            onChange={(e) =>
              setCursor((c) => clampTo(Number(e.target.value) * 12 + c.m))
            }
            aria-label="Year"
            className="select-bare pl-0.5 text-xs"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => shift(1)}
          disabled={atMax}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
          aria-label="Next month"
        >
          <IconChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-7 text-center text-xs font-medium text-slate-500 dark:text-slate-400">
        {dowOrder.map((wd, i) => (
          <div key={i}>{DOW[wd]}</div>
        ))}
      </div>

      <div className="mt-1 grid grid-cols-7 gap-y-0.5">
        {cells.map((cell, i) => {
          const ds = isoDate(cell.y, cell.m, cell.d);
          const isToday = ds === todayStr;
          const hasActivity = active.has(ds);
          const base =
            "mx-auto flex h-7 w-7 items-center justify-center rounded-full text-xs";

          if (hasActivity) {
            return (
              <Link
                key={i}
                href={`/timeline?from=${ds}&to=${ds}#timeline-day-${ds}`}
                title={`View ${ds}`}
                className={`${base} bg-brand-500/15 font-semibold text-brand-700 hover:bg-brand-500/25 dark:text-brand-300 ${
                  cell.outside ? "opacity-50" : ""
                } ${isToday ? "ring-1 ring-brand-400" : ""}`}
              >
                {cell.d}
              </Link>
            );
          }
          return (
            <div
              key={i}
              className={`${base} ${
                cell.outside
                  ? "text-slate-300 dark:text-slate-600"
                  : "text-slate-500 dark:text-slate-400"
              } ${isToday ? "ring-1 ring-slate-300" : ""}`}
            >
              {cell.d}
            </div>
          );
        })}
      </div>
    </div>
  );
}
