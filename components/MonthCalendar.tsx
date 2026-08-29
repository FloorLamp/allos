"use client";

import type { Route } from "next";
import { useState } from "react";
import Link from "next/link";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import IconButton from "@/components/IconButton";
import {
  MONTHS_LONG,
  dateStrInTz,
  isoDate,
  isRealIsoDate,
  monthGridCells,
  monthNames,
  weekdayOrder,
} from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useWeekStart } from "@/components/WeekStartProvider";

// THE APP'S ONE MONTH GRID (#3744). DateField's picker and the Timeline's event
// calendar had each grown a complete month calendar — cursor, month/year selectors,
// arrows, weekday row, a grid of WHOLE WEEKS, today/outside paint — and the two had
// drifted apart in month labels, bounds, arrow geometry and day semantics while
// claiming to be the same control.
//
// WHOLE WEEKS, NOT A FIXED 42 (`monthGridCells`, lib/date.ts). The grid pads to a
// complete first and last week and stops: March 2026 opens on a Sunday, so a
// Sunday-start profile gets 35 cells and a Monday-start one 42, and February in a
// non-leap year starting on its week-start day gets 28. Every count is a multiple of
// seven and nothing here may assume the largest one.
//
// A CLOSED BINDING, NOT A SLOT. A caller states what a DAY MEANS and nothing else:
// pick one (`selectable`) or open one (`linked`). Everything a person can see — cell
// shape, selected paint, the today ring and its ARIA, arrow geometry, how far the
// months run — belongs to this file, so the two surfaces cannot drift again without a
// change here that both of them get.
//
// IT RENDERS NO ROOT ELEMENT, deliberately. Its two hosts differ ONLY in the band or
// panel around the grid (the phone drawer's full-bleed break-out claims
// `--week-grid-min`; the popover already has the panel's own padding), so the host
// stays the caller's and there is no `className` seam here to widen later.
export type MonthCalendarBinding =
  | {
      kind: "selectable";
      /** The chosen ISO date, or "" — also what the cursor follows. */
      value: string;
      /** Inclusive ISO bounds; days and months outside them are refused. */
      min?: string;
      max?: string;
      onSelect: (iso: string) => void;
    }
  | {
      kind: "linked";
      /** The ISO days that have somewhere to go. */
      dates: readonly string[];
      href: (iso: string) => Route;
      /** A destination has been taken — a popover host closes on it. */
      onNavigate?: () => void;
    };

const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
// Short labels: the narrowest host is a phone drawer band, and the year selector sits
// right beside the month one, so "Jan 2026" is never ambiguous.
const MONTHS = monthNames("short");

// A month as one number — the only arithmetic this calendar does.
const monthIndex = (iso: string) => {
  const [y, m] = iso.split("-").map(Number);
  return y * 12 + (m - 1);
};

// THE HIT BOX TILES ITS COLUMN AND THE GLYPH IS THE PAINT (#3377, extended by #3954).
// Seven cells fill the row with no dead pixels: a tap that lands between two days
// reads as broken exactly like one that lands on the wrong day. That tiling is also
// why a day's reach is block-only (app/globals.css) — the inline axis has no gap to
// spend, so the row gap pays the floor where a coarse pointer has a reach at all.
const DAY_HIT = "flex h-(--control-box) w-full items-center justify-center";
// AND THE CIRCLE IS 28, NOT THE BOX. The two calendars disagreed here — the picker
// filled its cell, the sidebar kept a smaller disc — and the sidebar is right: a
// circle as tall as its row touches the circles above and below it, so the month
// reads as columns of discs rather than a grid of days. This is the hit-slop idiom,
// not a bigger calendar, and e2e/mobile-ui-polish.spec.ts has been measuring it.
const DAY_GLYPH =
  "flex h-7 w-7 items-center justify-center rounded-full text-sm transition";

export default function MonthCalendar({
  binding,
}: {
  binding: MonthCalendarBinding;
}) {
  const todayStr = dateStrInTz(useTimezone());
  const todayIdx = monthIndex(todayStr);
  // The profile's first day of the week (0=Sun … 6=Sat); reorders the header and the
  // grid so each row starts on that day.
  const weekStart = useWeekStart();
  const dowOrder = weekdayOrder(weekStart);
  const marked = binding.kind === "linked" ? new Set(binding.dates) : null;

  // HOW FAR THE MONTHS RUN, from the binding rather than from the caller. Selection is
  // bounded by the field's own min/max, or by a generous window when it has none (back
  // for birthdates, forward for goal dates). A linked grid runs from its earliest
  // destination to its latest and always contains today, so the current month stays
  // reachable even when every event sits in the past.
  const bounds =
    binding.kind === "selectable"
      ? {
          minIdx: binding.min
            ? monthIndex(binding.min)
            : (Number(todayStr.slice(0, 4)) - 120) * 12,
          maxIdx: binding.max
            ? monthIndex(binding.max)
            : (Number(todayStr.slice(0, 4)) + 10) * 12 + 11,
        }
      : binding.dates.reduce(
          (acc, d) => {
            const idx = monthIndex(d);
            return {
              minIdx: Math.min(acc.minIdx, idx),
              maxIdx: Math.max(acc.maxIdx, idx),
            };
          },
          { minIdx: todayIdx, maxIdx: todayIdx }
        );
  const clampTo = (idx: number) => {
    const c = Math.min(bounds.maxIdx, Math.max(bounds.minIdx, idx));
    return { y: Math.floor(c / 12), m: c % 12 };
  };

  // THE CURSOR FOLLOWS A CHOSEN VALUE AND NOTHING ELSE. Only a real date moves it, so
  // a well-formed-but-impossible entry ("2026-13-01") cannot push the month outside
  // 0-11 and desync the month <select>; a linked grid has no value to follow and opens
  // on today.
  const follow =
    binding.kind === "selectable" && isRealIsoDate(binding.value)
      ? binding.value
      : null;
  const [state, setState] = useState(() => ({
    seen: follow,
    cursor: clampTo(follow ? monthIndex(follow) : todayIdx),
  }));
  if (state.seen !== follow) {
    setState((current) => ({
      seen: follow,
      cursor: follow ? clampTo(monthIndex(follow)) : current.cursor,
    }));
  }
  const cursor = state.cursor;
  const cursorIdx = cursor.y * 12 + cursor.m;
  const goTo = (idx: number) =>
    setState({ seen: follow, cursor: clampTo(idx) });

  const minYear = Math.floor(bounds.minIdx / 12);
  const maxYear = Math.floor(bounds.maxIdx / 12);
  const years = Array.from(
    { length: maxYear - minYear + 1 },
    (_, i) => maxYear - i
  );
  const cells = monthGridCells(cursor.y, cursor.m, weekStart);

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-1">
        <IconButton
          label="Previous month"
          disabled={cursorIdx <= bounds.minIdx}
          onClick={() => goTo(cursorIdx - 1)}
        >
          <IconChevronLeft className="h-4 w-4" />
        </IconButton>
        <div className="flex min-w-0 items-center gap-0.5">
          <select
            value={cursor.m}
            onChange={(e) => goTo(cursor.y * 12 + Number(e.target.value))}
            aria-label="Month"
            className="select-bare pl-0.5 text-sm"
          >
            {MONTHS.map((label, m) => {
              const idx = cursor.y * 12 + m;
              return (
                <option
                  key={m}
                  value={m}
                  disabled={idx < bounds.minIdx || idx > bounds.maxIdx}
                >
                  {label}
                </option>
              );
            })}
          </select>
          <select
            value={cursor.y}
            onChange={(e) => goTo(Number(e.target.value) * 12 + cursor.m)}
            aria-label="Year"
            className="select-bare pl-0.5 text-sm"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <IconButton
          label="Next month"
          disabled={cursorIdx >= bounds.maxIdx}
          onClick={() => goTo(cursorIdx + 1)}
        >
          <IconChevronRight className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="grid grid-cols-7 text-center text-xs font-medium text-slate-500 dark:text-slate-400">
        {dowOrder.map((wd, i) => (
          <div key={i}>{DOW[wd]}</div>
        ))}
      </div>

      {/* The row gap pays the reach floor where the reach exists (#3954). */}
      <div className="mt-1 grid grid-cols-7 gap-y-0.5 pointer-coarse:gap-y-3">
        {cells.map((cell, i) => {
          const ds = isoDate(cell.y, cell.m, cell.d);
          const isToday = ds === todayStr;
          const selected =
            binding.kind === "selectable" && ds === binding.value;
          const linked = marked?.has(ds) ?? false;
          const refused =
            binding.kind === "selectable" &&
            ((!!binding.min && ds < binding.min) ||
              (!!binding.max && ds > binding.max));

          // ONE LADDER, BOTH BINDINGS, and the order is the precedence: a chosen day
          // looks chosen even when it is also today, and a day nothing can be done
          // with never looks actionable. `outside` only mutes what is left.
          const paint = selected
            ? "bg-brand-600 font-semibold text-white hover:bg-brand-700"
            : linked
              ? "bg-brand-500/15 font-semibold text-brand-700 hover:bg-brand-500/25 dark:text-brand-300"
              : refused
                ? "cursor-not-allowed text-slate-300 dark:text-slate-700"
                : binding.kind === "linked"
                  ? "text-slate-500 dark:text-slate-400"
                  : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-ink-800";
          const glyph = `${DAY_GLYPH} ${paint} ${
            cell.outside ? "opacity-50" : ""
          } ${!selected && isToday ? "ring-1 ring-brand-400" : ""}`;

          // The whole date, not the bare numeral: a screen reader arriving in the
          // middle of the grid hears which day "17" is.
          const shared = {
            "data-calendar-day": "",
            className: DAY_HIT,
            "aria-label": `${MONTHS_LONG[cell.m]} ${cell.d}, ${cell.y}`,
            "aria-current": isToday ? ("date" as const) : undefined,
          };
          const face = <span className={glyph}>{cell.d}</span>;

          if (binding.kind === "linked") {
            return linked ? (
              <Link
                key={i}
                {...shared}
                href={binding.href(ds)}
                onClick={binding.onNavigate}
              >
                {face}
              </Link>
            ) : (
              <div key={i} {...shared}>
                {face}
              </div>
            );
          }
          return (
            <button
              key={i}
              {...shared}
              type="button"
              disabled={refused}
              onClick={() => binding.onSelect(ds)}
            >
              {face}
            </button>
          );
        })}
      </div>
    </>
  );
}
