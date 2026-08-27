"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "@tabler/icons-react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import { useCompactViewport } from "@/components/useCompactViewport";
import {
  dateStrInTz,
  isoDate,
  monthGridCells,
  monthNames,
  weekdayOrder,
} from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useWeekStart } from "@/components/WeekStartProvider";

// THE SIDEBAR'S EVENT CALENDAR — a month grid whose marked days are a door into
// the Timeline (#3079's usage review), one row at rest (#3154).
//
// IT IS NOT A TRAINING CALENDAR AND HAS NOT BEEN FOR A LONG TIME. It was named
// `TrainingLogCalendar` with an `activeDates` prop, and the app layout fed it
// `getTimelineDates` — the union of EVERY event store: body metrics, doses,
// symptoms, practices, immunizations, encounters, milestones, protocols, with
// training as one optional member. The name outlived the data, and the
// `trainingRelevant` gate that came with it took the calendar away from exactly
// the profiles whose events it marks best — a child's immunizations, milestones
// and symptoms. Both are gone; the union itself (lib/timeline.ts) is untouched.
//
// TWO HOSTS, ONE GRID, the fork components/overlay/AnchoredPanel.tsx already
// makes for every other anchored panel in the app:
//
//   * FROM `md` UP — one ~40px "Calendar" row that opens the grid in an anchored
//     popover, over the same primitive the sidebar's "+ Log" panel uses. The
//     resting cost was ~230px of permanent single-column chrome, which is what
//     pushed Data, Settings and the whole footer below the fold; the popover is
//     portaled and `fixed`, so opening it shifts neither the nav nor the footer,
//     and the grid is no longer confined to the column's width.
//   * BELOW `md` — the phone drawer's full-bleed band, unchanged. The drawer
//     scrolls, so it never had the fold problem the row solves, and its 44px
//     columns are a tap-floor claim (#3377/#3452/#3536) that a popover would
//     drop on the floor.
//
// No badge, no count, no dot on the row: the dock's never-campaigns doctrine
// (#2651) applies to permanent chrome wherever it sits.

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
// `w-72`, told to the positioner so the panel's first paint is already clamped
// inside the viewport rather than measured into place afterwards.
const PANEL_WIDTH_PX = 288;

// The circle a reader sees. Unchanged at every width.
const DAY_GLYPH =
  "flex h-7 w-7 items-center justify-center rounded-full text-xs";

function MonthGrid({
  eventDates,
  hostClassName,
}: {
  eventDates: string[];
  // The band the grid sits in — the ONE thing its two hosts do not share. The
  // phone drawer's is a full-bleed break-out (see the note above it below); the
  // desktop popover already has the panel's own border and padding around it.
  hostClassName: string;
}) {
  const active = new Set(eventDates);
  // Match the rest of the app's notion of "today" (the configured app timezone, as
  // used by lib/db `today()`), so the circled day lines up with logged-today entries.
  const todayStr = dateStrInTz(useTimezone());
  const [ty, tm] = todayStr.split("-").map(Number);
  // The profile's first day of the week (0=Sun … 6=Sat); reorders the header and
  // grid so each row starts on that day.
  const weekStart = useWeekStart();
  const dowOrder = weekdayOrder(weekStart);

  // Navigation is bounded: back to January of the earliest year holding an
  // event, and forward to the current month (or the latest event, if one is
  // somehow dated ahead of today). Month indices are y*12 + m.
  let minAct = Infinity;
  let maxAct = -Infinity;
  for (const d of eventDates) {
    const [y, m] = d.split("-").map(Number);
    const idx = y * 12 + (m - 1);
    if (idx < minAct) minAct = idx;
    if (idx > maxAct) maxAct = idx;
  }
  const nowIdx = ty * 12 + (tm - 1);
  // Earliest navigable year: January of the earliest event year, but never later
  // than the current year — today must always be reachable, even if the only
  // event is (somehow) dated in the future.
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
    <div className={hostClassName}>
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
          const marked = active.has(ds);

          if (marked) {
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

// The phone drawer's band, CLAIMED rather than assumed (#3377/#3452). Its
// `min-w-(--week-grid-min)` is what seven 44px columns cost, stated once in
// app/globals.css and read here and by the drawer's own width class (#3536) —
// slack at every width the drawer offers, which is the point: a host narrower
// than a week overflows visibly instead of quietly redistributing the columns
// back under the tap floor, the failure #3377 found and no DOM assertion would
// have caught. The band gives up the drawer's right gutter and the part of its
// left gutter outside the safe-area inset, so its left edge lands exactly on
// `env(safe-area-inset-left)` and never behind it; the side borders and corner
// radius go with it, so it reads as a band rather than a card jammed against the
// drawer's edges.
const PHONE_BAND =
  "-mr-4 ml-[calc(env(safe-area-inset-left)_-_max(1rem,env(safe-area-inset-left)))] min-w-(--week-grid-min) border-y border-black/10 py-3 dark:border-white/10";

export default function EventCalendar({
  eventDates,
}: {
  eventDates: string[];
}) {
  const compact = useCompactViewport();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (compact)
    return <MonthGrid eventDates={eventDates} hostClassName={PHONE_BAND} />;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        data-testid="sidebar-calendar"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="sidebar-calendar-panel"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-slate-600 transition hover:bg-(--ghost-hover) dark:text-slate-300"
      >
        <IconCalendar className="h-4 w-4 shrink-0" stroke={1.75} />
        Calendar
      </button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        title="Calendar"
        panelId="sidebar-calendar-panel"
        testId="sidebar-calendar-panel"
        fallbackWidth={PANEL_WIDTH_PX}
        panelClassName="w-72"
      >
        {() => <MonthGrid eventDates={eventDates} hostClassName="p-3" />}
      </AnchoredPanel>
    </>
  );
}
