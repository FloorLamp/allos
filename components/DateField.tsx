"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
import { formatLongDate, daysRemainingLabel } from "@/lib/format-date";

// Styled, theme-consistent replacement for <input type="date">. The browser's
// native date popup can't be CSS-styled, so we render our own calendar.
//
// Works both uncontrolled (pass `name` + optional `defaultValue` — submits the
// ISO yyyy-mm-dd value in a form, exactly like the native input) and controlled
// (pass `value` + `onChange`). The text field accepts manual ISO entry too.
const DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = monthNames("long");
const PANEL_WIDTH = 288; // matches w-72
const GAP = 4; // matches mt-1
const MARGIN = 8; // keep the panel this far from the viewport edges

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
}) {
  const controlled = value !== undefined;
  const [inner, setInner] = useState(defaultValue);
  const val = controlled ? value! : inner;
  const setVal = (v: string) => (controlled ? onChange?.(v) : setInner(v));

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The calendar is portaled to <body> and positioned `fixed` from the field's
  // bounding rect so it's never clipped by an `overflow` ancestor (e.g. the
  // journal editor's max-h scroll container). See OverflowMenu for the pattern.
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

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
        ? "Please enter a valid date (YYYY-MM-DD)."
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
  const [cursor, setCursor] = useState({ y: sy, m: sm - 1 });

  // Follow the typed/selected value to the right month — but only once it's a
  // real date, so a well-formed-but-impossible entry ("2026-13-01") can't push
  // cursor.m outside 0-11 and desync the month <select>.
  useEffect(() => {
    if (validISO(val)) {
      const [y, m] = val.split("-").map(Number);
      setCursor({ y, m: m - 1 });
    }
  }, [val]);

  // Close on outside click. The panel is portaled outside `ref`, so a click
  // inside it must also count as "inside" or picking a day would close first.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Position the portaled panel below the field, flipping above when it won't
  // fit, and track scroll (in any ancestor, hence capture) and resize.
  const reposition = useCallback(() => {
    const anchor = ref.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const ph = popRef.current?.offsetHeight ?? 0;
    let top = r.bottom + GAP;
    if (top + ph > window.innerHeight - MARGIN && r.top - GAP - ph > MARGIN)
      top = r.top - GAP - ph;
    let left = r.left;
    left = Math.max(
      MARGIN,
      Math.min(left, window.innerWidth - PANEL_WIDTH - MARGIN)
    );
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition]);

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
        const to = e.relatedTarget as Node | null;
        if (!ref.current?.contains(to) && !popRef.current?.contains(to))
          setOpen(false);
      }}
    >
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={validISO(val) ? formatLongDate(val) : val}
        required={required}
        autoFocus={autoFocus}
        placeholder={placeholder}
        inputMode="numeric"
        title="Date in YYYY-MM-DD format"
        autoComplete="off"
        onChange={(e) => setVal(e.target.value)}
        onFocus={() => setOpen(true)}
        className={`input pr-10 ${inputClassName}`}
      />
      {/* The visible field can show a friendly date, so the ISO value is
          submitted via a hidden input for uncontrolled (name) usage. */}
      {name && <input type="hidden" name={name} value={val} />}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Open calendar"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
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
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          {daysRemainingLabel(val, todayStr)}
        </p>
      )}

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
            }}
            className="z-50 w-72 rounded-lg border border-black/10 bg-white p-3 shadow-lg dark:border-white/10 dark:bg-ink-900"
          >
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
                  className="flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                >
                  <IconChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => shift(1)}
                  aria-label="Next month"
                  className="flex h-8 w-8 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-ink-800 dark:hover:text-slate-200"
                >
                  <IconChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-7 text-center text-xs font-medium text-slate-400 dark:text-slate-500">
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
                    className={`mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm transition ${
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
                className="font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
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
                className="font-medium text-brand-600 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-40 dark:text-brand-400 dark:hover:text-brand-300"
              >
                Today
              </button>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
