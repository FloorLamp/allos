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

// THE HIT AREA AND THE GLYPH ARE TWO BOXES BELOW `md` (#3377) — the padding/hit-slop
// idiom the app already uses for its icon-only triggers. The month arrow's chevron
// stays 16px and the day's circle stays 28px at every width; what grows on a phone is
// the box a finger lands in. From `md` up the outer box collapses back onto the glyph,
// so the desktop sidebar's density is unchanged.
//
// 44, NOT THE 40 THESE WERE BUILT AT. #3377 sized both boxes against the floor as it
// stood then, and it sized them correctly; #3514 ruled the floor to 44px EFFECTIVE on
// 2026-08-21 and these were left behind — 40px, neither registered mechanism, and
// invisible to the census that enumerates exactly this population, because a hoisted
// class list came back to it as the word `ARROW_HIT` (#3561).
const ARROW_HIT =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 md:h-6 md:w-6 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200";

// The day cell's hit box: the FULL grid column and 44px tall on a phone, the bare 28px
// circle from `md` up. `w-full` rather than a fixed width so the columns tile the grid
// with no dead pixels between them — a tap that lands nowhere reads as a broken day
// just as a tap that lands next door does.
//
// What SEVEN of those columns cost is `--week-grid-min` (app/globals.css, #3452) —
// stated there once, because the phone nav drawer has to be wide enough to pay for it
// and used to derive the same number a second time in its own width class. The
// full-bleed band below claims that minimum and spends its gutter so every column
// reaches the same 44px rendered floor as its height; the phone drawer reserves the
// width for it (#3536). The desktop sidebar keeps the bare 28px circles.
const DAY_HIT =
  "flex h-11 w-full items-center justify-center md:mx-auto md:h-7 md:w-7";
// The circle a reader sees. Unchanged at every width.
const DAY_GLYPH =
  "flex h-7 w-7 items-center justify-center rounded-full text-xs";

export default function TrainingLogCalendar({
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
    // FULL-BLEED IN THE PHONE DRAWER, THE BORDERED CARD ON DESKTOP (#3377).
    //
    // This grid is a PHONE surface: components/MobileNav.tsx renders the same
    // <SidebarContent> inside the nav drawer, where its 28px day links sat ~35%
    // under the old 40px tap floor (#644). #3536 raised the drawer to a 320px
    // preferred width that grows with any left safe-area inset, so this full-bleed
    // band can give all seven columns at least 44px. Below `md` the card gives up
    // the drawer's right gutter and only the part of its left gutter outside the
    // safe-area inset. Its left edge therefore lands exactly on
    // `env(safe-area-inset-left)`, never behind it, while the drawer width pays for
    // the whole week. The side borders and the corner radius go with it, so it
    // reads as a band rather than a card jammed against the drawer's edges.
    //
    // `min-w-(--week-grid-min)` is that bill, CLAIMED rather than assumed (#3452).
    // It is slack at every width the drawer actually offers — which is the point:
    // if a host ever gets narrower than a week, the columns overflow visibly
    // instead of quietly redistributing themselves back under the tap floor, which
    // is exactly the failure #3377 found and no DOM assertion would have caught.
    //
    // From `md` up every one of those is put back — the minimum included, since the
    // desktop sidebar is narrower than a touch week and renders the bare 28px
    // circles instead — and the desktop sidebar is byte-identical to before.
    <div className="-mr-4 ml-[calc(env(safe-area-inset-left)_-_max(1rem,env(safe-area-inset-left)))] min-w-(--week-grid-min) border-y border-black/10 py-3 md:mx-0 md:min-w-0 md:rounded-lg md:border-x md:px-3 dark:border-white/10">
      <div className="mb-2 flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={() => shift(-1)}
          disabled={atMin}
          className={ARROW_HIT}
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
          className={ARROW_HIT}
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

          if (hasActivity) {
            return (
              <Link
                key={i}
                href={`/timeline?from=${ds}&to=${ds}#timeline-day-${ds}`}
                className={DAY_HIT}
              >
                <span
                  className={`${DAY_GLYPH} bg-brand-500/15 font-semibold text-brand-700 hover:bg-brand-500/25 dark:text-brand-300 ${
                    cell.outside ? "opacity-50" : ""
                  } ${isToday ? "ring-1 ring-brand-400" : ""}`}
                >
                  {cell.d}
                </span>
              </Link>
            );
          }
          return (
            <div key={i} className={DAY_HIT}>
              <span
                className={`${DAY_GLYPH} ${
                  cell.outside
                    ? "text-slate-300 dark:text-slate-600"
                    : "text-slate-500 dark:text-slate-400"
                } ${isToday ? "ring-1 ring-slate-300" : ""}`}
              >
                {cell.d}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
