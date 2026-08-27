"use client";

import { useEffect, useRef, useState, type SetStateAction } from "react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import { useCompactViewport } from "@/components/useCompactViewport";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import {
  dateStrInTz,
  isoDate,
  isRealIsoDate,
  monthGridCells,
  monthNames,
  weekdayOrder,
  type CalendarCell,
} from "@/lib/date";
import { useTimezone } from "@/components/TimezoneProvider";
import { useWeekStart } from "@/components/WeekStartProvider";
import { formatDateWithYear, daysRemainingLabel } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";

// Styled, theme-consistent replacement for <input type="date">. The browser's
// native date popup can't be CSS-styled, so we render our own calendar.
//
// WHERE THAT CALENDAR OPENS FORKS AT `md` (#3376). This file had zero `md:`
// classes and no touch handling, so a phone got the desktop calendar: a 288px
// panel of 36px day cells hanging off the field. It now hands its content to
// components/overlay/AnchoredPanel.tsx, which mounts it as a bottom sheet below
// `md` and as the anchored popover from `md` up — the same calendar, authored
// once, never a `hidden md:` twin (#2305).
//
// Falling back to the bare native `<input type="date">` on phones was the
// recorded alternative and is NOT what shipped: the custom calendar exists
// precisely for the today ring, the min/max range hints and the theme the native
// popup cannot carry, and dropping to native below `md` would mean the phone
// loses exactly the affordances the desktop keeps.
//
// Works both uncontrolled (pass `name` + optional `defaultValue` — submits the
// ISO yyyy-mm-dd value in a form, exactly like the native input) and controlled
// (pass `value` + `onChange`). The text field accepts manual ISO entry too.
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = monthNames("long");
const PANEL_WIDTH = 288; // matches w-72

// True only for a real calendar date in ISO form (shared helper — see lib/date).
const validISO = isRealIsoDate;

export default function DateField({
  name,
  value,
  onChange,
  defaultValue = "",
  required = false,
  id,
  placeholder = "yyyy-mm-dd",
  autoFocus = false,
  showCountdown = false,
  min,
  max,
  inputClassName = "",
  "data-testid": testId,
}: {
  name?: string;
  value?: string;
  onChange?: (v: string) => void;
  defaultValue?: string;
  required?: boolean;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  // Show "N days left" / "overdue" under the field once a valid date is set.
  showCountdown?: boolean;
  // Optional inclusive ISO (yyyy-mm-dd) bounds. Days outside the range are
  // disabled in the calendar and rejected by the text field, mirroring the
  // native <input type="date"> min/max attributes.
  min?: string;
  max?: string;
  inputClassName?: string;
  "data-testid"?: string;
}) {
  const formatPrefs = useFormatPrefs();
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue);
  const val = controlled ? value! : inner;
  const setVal = (v: string) => (controlled ? onChange?.(v) : setInner(v));

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLElement | null>(null);
  // WHICH HOST THE CALENDAR OPENS IN, below `md` versus above it (#3376). The
  // panel itself is components/overlay/AnchoredPanel.tsx's decision and this
  // file does not repeat it — but the OUTSIDE-CLICK policy genuinely differs by
  // host, and that is what this reads. See the two guards below.
  const compact = useCompactViewport();

  // Is this ISO date outside the optional [min, max] window? Plain string
  // comparison works because ISO yyyy-mm-dd sorts chronologically.
  const outOfRange = (ds: string) => (!!min && ds < min) || (!!max && ds > max);

  // The native <input type="date"> blocked malformed and out-of-range values;
  // this text input doesn't, so enforce both via the Constraint Validation API.
  // (`required` only covers empty.) The range check is inlined so the effect's
  // dependencies stay the primitives it actually reads.
  useEffect(() => {
    inputRef.current?.setCustomValidity(
      val && !validISO(val)
        ? "Enter a valid date (YYYY-MM-DD)."
        : val && ((!!min && val < min) || (!!max && val > max))
          ? "Date is outside the allowed range."
          : ""
    );
  }, [val, min, max]);

  const todayStr = dateStrInTz(useTimezone());
  // The profile's first day of the week (0=Sun … 6=Sat); reorders the header and
  // grid so each row starts on that day.
  const weekStart = useWeekStart();
  const dowOrder = weekdayOrder(weekStart);
  const seed = validISO(val) ? val : todayStr;
  const [sy, sm] = seed.split("-").map(Number);
  type Cursor = { y: number; m: number };
  const [cursorState, setCursorState] = useState<{
    seenValue: string;
    cursor: Cursor;
  }>({ seenValue: val, cursor: { y: sy, m: sm - 1 } });

  // Follow the typed/selected value to the right month — but only once it's a
  // real date, so a well-formed-but-impossible entry ("2026-13-01") can't push
  // cursor.m outside 0-11 and desync the month <select>.
  if (cursorState.seenValue !== val) {
    const nextCursor = validISO(val)
      ? (() => {
          const [y, m] = val.split("-").map(Number);
          return { y, m: m - 1 };
        })()
      : cursorState.cursor;
    setCursorState({ seenValue: val, cursor: nextCursor });
  }
  const cursor = cursorState.cursor;
  function setCursor(next: SetStateAction<Cursor>) {
    setCursorState((current) => ({
      seenValue: val,
      cursor: typeof next === "function" ? next(current.cursor) : next,
    }));
  }

  // Close on outside click — the POPOVER's dismissal, and only its. The panel is
  // portaled outside `ref`, so a click inside it must also count as "inside" or
  // picking a day would close first.
  //
  // The SHEET owns its own dismissal (scrim, flick, Escape) and must not have
  // this running underneath it: `mousedown` lands before `click`, so a listener
  // that treats the sheet's chrome as "outside" would close the calendar — and
  // unmount the day button — before the tap on it ever became a click.
  useEffect(() => {
    if (!open || compact) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, compact, popRef]);

  const cells = monthGridCells(cursor.y, cursor.m, weekStart);

  // A generous year range for the selector: back far enough for birthdates,
  // forward for future goal dates, clamped to any min/max bound, and always
  // widened to include the cursor so the current month stays selectable.
  const todayYear = Number(todayStr.slice(0, 4));
  const loYear = min ? Number(min.slice(0, 4)) : todayYear - 120;
  const hiYear = max ? Number(max.slice(0, 4)) : todayYear + 10;
  const minY = Math.min(loYear, cursor.y);
  const maxY = Math.max(hiYear, cursor.y);
  const years = Array.from({ length: maxY - minY + 1 }, (_, i) => maxY - i);

  function shift(delta: number) {
    setCursor((c) => {
      const t = c.y * 12 + c.m + delta;
      return { y: Math.floor(t / 12), m: ((t % 12) + 12) % 12 };
    });
  }
  function pick(cell: CalendarCell) {
    setVal(isoDate(cell.y, cell.m, cell.d));
    setOpen(false);
  }

  return (
    <div
      className="relative"
      ref={ref}
      data-escape-layer={open ? "true" : undefined}
      // Keep Escape from bubbling to a parent modal/dialog when the picker is open.
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      // Close when focus leaves the picker entirely (e.g. tabbing away), which a
      // mousedown-only outside-click handler misses. The panel is portaled, so
      // focus landing in it counts as staying inside.
      onBlur={(e) => {
        // Same split as the outside-click listener above: below `md` the sheet
        // traps focus and owns dismissal, so "focus left the field" is what
        // OPENING it looks like, not a reason to close.
        if (compact) return;
        const to = e.relatedTarget as Node | null;
        if (!ref.current?.contains(to) && !popRef.current?.contains(to))
          setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        data-testid={testId}
        id={id}
        type="text"
        value={validISO(val) ? formatDateWithYear(val, formatPrefs) : val}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        inputMode="numeric"
        autoComplete="off"
        onChange={(e) => setVal(e.target.value)}
        // FOCUS OPENS THE CALENDAR ONLY WHERE IT IS A POPOVER. From `md` up the
        // panel floats beside the field and focus stays in the input, so opening
        // on focus costs the typist nothing. Below `md` the calendar is a modal
        // sheet that TAKES focus — opening it the moment the field is tapped
        // would mean the field could never be typed into on a phone at all. The
        // calendar button beside the input is the phone's way in, and manual ISO
        // entry keeps working at every width (#3376's invariant).
        onFocus={() => {
          if (!compact) setOpen(true);
        }}
        // The field renders the vocabulary's year-bearing short form ("Jul 24,
        // 2026") rather than formatLongDate's "Friday, July 24" (issue #1450
        // cluster A / #1448): ~20% narrower, and dated, which a date being EDITED
        // always wants. `pr-9` (not pr-10) matches the calendar button's real
        // reach — a 1rem glyph inset 0.5rem — returning 4px to the value.
        //
        // Deliberately NO min-width: date fields sit inside layouts with their own
        // pinned geometry (the activity editor's Date/Duration/Start/End are one
        // equal-width row, #188), so a floor here would break those instead. Where
        // a date genuinely could not fit, the CONTAINER was too narrow and is
        // widened at the container.
        className={`input pr-9 ${inputClassName}`}
      />
      {/* The visible field can show a friendly date, so the ISO value is
          submitted via a hidden input for uncontrolled (name) usage. */}
      {name && <input type="hidden" name={name} value={val} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open calendar"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-300"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
        >
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M3 9h18M8 2v4M16 2v4" strokeLinecap="round" />
        </svg>
      </button>

      {showCountdown && validISO(val) && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          {daysRemainingLabel(val, todayStr)}
        </p>
      )}

      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        // The sheet's heading. The field it belongs to is right behind the
        // scrim, so this says what the surface is FOR rather than repeating a
        // label the viewer can still see.
        title="Choose a date"
        testId="date-field-calendar"
        sheetTestId="date-field-sheet"
        panelRef={popRef}
        fallbackWidth={PANEL_WIDTH}
        panelClassName="w-72 p-3"
        popoverZIndexClass="z-70"
        sheetZIndexClass="z-70"
        // The field keeps its own outside-click and blur handling: a
        // full-viewport catcher here would swallow the click that moves to the
        // NEXT field instead of letting it land.
        backdrop={false}
        escapeLayer
      >
        {() => (
          <>
            <div className="mb-2 flex items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                <select
                  value={cursor.m}
                  onChange={(e) =>
                    setCursor((c) => ({ ...c, m: Number(e.target.value) }))
                  }
                  aria-label="Month"
                  className="select-bare py-0.5 pl-1 text-sm"
                >
                  {MONTHS.map((label, m) => (
                    <option key={m} value={m}>
                      {label}
                    </option>
                  ))}
                </select>
                <select
                  value={cursor.y}
                  onChange={(e) =>
                    setCursor((c) => ({ ...c, y: Number(e.target.value) }))
                  }
                  aria-label="Year"
                  className="select-bare py-0.5 pl-1 text-sm"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => shift(-1)}
                  aria-label="Previous month"
                  className="flex h-11 w-11 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 md:h-8 md:w-8 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                >
                  <IconChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => shift(1)}
                  aria-label="Next month"
                  className="flex h-11 w-11 items-center justify-center rounded-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 md:h-8 md:w-8 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                >
                  <IconChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 text-center text-xs font-medium text-slate-500 dark:text-slate-400">
              {dowOrder.map((wd, i) => (
                <div key={i}>{DOW[wd]}</div>
              ))}
            </div>

            <div className="mt-1 grid grid-cols-7 gap-y-0.5">
              {cells.map((cell, i) => {
                const ds = isoDate(cell.y, cell.m, cell.d);
                const selected = ds === val;
                const isToday = ds === todayStr;
                const disabled = outOfRange(ds);
                return (
                  <button
                    key={i}
                    type="button"
                    disabled={disabled}
                    onClick={() => pick(cell)}
                    // 44px below `md` (#644's floor, and #3376's acceptance
                    // criterion); the desktop popover keeps its compact 36px
                    // grid, which is what its 288px panel is measured for.
                    className={`mx-auto flex h-11 w-11 items-center justify-center rounded-full text-sm transition md:h-9 md:w-9 ${
                      selected
                        ? "bg-brand-600 font-semibold text-white hover:bg-brand-700"
                        : disabled
                          ? "cursor-not-allowed text-slate-300 dark:text-slate-700"
                          : `hover:bg-slate-100 dark:hover:bg-ink-800 ${
                              cell.outside
                                ? "text-slate-400 dark:text-slate-600"
                                : "text-slate-700 dark:text-slate-200"
                            } ${isToday ? "ring-1 ring-brand-400" : ""}`
                    }`}
                  >
                    {cell.d}
                  </button>
                );
              })}
            </div>

            <div className="mt-2 flex items-center justify-between border-t border-black/10 pt-2 text-sm dark:border-white/10">
              <button
                type="button"
                onClick={() => {
                  setVal("");
                  setOpen(false);
                }}
                className="py-3 font-medium text-slate-500 hover:text-slate-700 md:py-0 dark:text-slate-400 dark:hover:text-slate-200"
              >
                Clear
              </button>
              <button
                type="button"
                disabled={outOfRange(todayStr)}
                onClick={() => {
                  setVal(todayStr);
                  setOpen(false);
                }}
                className="py-3 font-medium text-brand-600 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40 md:py-0 dark:text-brand-400 dark:hover:text-brand-300"
              >
                Today
              </button>
            </div>
          </>
        )}
      </AnchoredPanel>
    </div>
  );
}
