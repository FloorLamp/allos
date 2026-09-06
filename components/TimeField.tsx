"use client";

import { useEffect, useRef, useState } from "react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import { useCompactViewport } from "@/components/useCompactViewport";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import {
  formatClock,
  parseClockHhmm,
  parseTypedClock,
  type TimeFormat,
} from "@/lib/format-date";

// Styled, theme-consistent replacement for <input type="time"> — `DateField`'s
// sibling, and built for the same reason (#4218). The native control's segments,
// spinners and picker are the browser's own, differ per OS, and sat in the same
// flex row as the fully themed date half of `WhenControl`. It also ignored the
// app's own clock: `timeFormat` (#964) governs every other rendered time, while
// the native input follows the OS locale, so a profile set to 24h could still be
// handed an AM/PM widget.
//
// SEMANTICS-FREE, exactly like `DateField`. Value in, value out: canonical 24h
// "HH:MM" or "" for "no time". The pair rules — never default to now, the "Now"
// offer, re-anchoring, bounds, `timeRequired` — stay `WhenControl`'s (#2236).
//
// TYPE OR PICK. The text field accepts either clock ("19:30", "7:30pm") and the
// shorthand around them ("630", "6p", "1124p") through `parseTypedClock`, and
// renders its value in the profile's own. Typing keeps working at every width,
// which is the invariant #3376 fixed for the date half. The TYPED reader is a
// separate function from `parseClockHhmm`, which stays the strict reader for
// STORED clock text — see its own comment for why the two must not converge.
//
// ONE AUTHORED PICKER, hosted by `AnchoredPanel` exactly as the calendar is: an
// anchored popover from `md` up, a bottom sheet below, never a `hidden md:` twin
// (#2305). AND ROLE-LESS, exactly as the calendar is: a panel that declares a
// role is one `AnchoredPanel` moves focus INTO on open (#3905), which is right
// for a menu a button promised and wrong for a picker that opens when the FIELD
// takes focus — the caret would leave the input the person just clicked into,
// and their next keystroke would land in the hour column. The field itself is
// the keyboard route here (typing, and the arrows step by a minute), so the
// wheel promises no popup and nothing pulls focus out of the input. The picker is a SCROLL-SNAP WHEEL — real scroll containers, so flick
// momentum and detent snapping are the platform's own physics rather than a
// gesture recognizer this file would have to own. Chosen over dropping to native
// below `md` knowing a web page gets no haptic tick on iOS: the look being the
// app's is the point, and it is the same trade `DateField` records for the
// calendar.
export default function TimeField({
  value,
  onChange,
  required = false,
  disabled = false,
  id,
  name,
  label,
  inputClassName = "",
  "data-testid": testId,
}: {
  /** Canonical 24h "HH:MM", or "" for "no time". */
  value: string;
  onChange: (next: string) => void;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  /**
   * Posts the canonical value through a form's FormData (DateField's own
   * pattern, below) — the visible field can show a formatted clock, so a
   * hidden input carries the "HH:MM" a Server Action reads.
   */
  name?: string;
  /** The field's accessible name — its visible label is the caller's. */
  label: string;
  inputClassName?: string;
  "data-testid"?: string;
}) {
  const { timeFormat } = useFormatPrefs();
  const [open, setOpen] = useState(false);
  // What the field shows WHILE IT IS BEING TYPED INTO. The parent holds only
  // canonical "HH:MM", so "7:3" has nowhere to live there — and re-rendering the
  // half-typed text from a value that has not moved would fight the typist.
  //
  // THE DRAFT REMEMBERS WHICH VALUE IT WAS TYPED AGAINST, which is what makes it
  // expire without an effect. When the parent's value moves for a reason that is
  // not this typing — the control's one-tap "Now", a date re-anchor, a form reset
  // — `from` no longer matches and the field falls back to rendering the value.
  const [draft, setDraft] = useState<{ text: string; from: string } | null>(
    null
  );
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLElement | null>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  // WHICH HOST the wheel opens in decides the outside-click policy, and only
  // that — the fork itself is `AnchoredPanel`'s and is not repeated here. Same
  // split, and the same reasons, as `DateField`.
  const compact = useCompactViewport();

  const shown =
    draft && draft.from === value ? draft.text : formatHhmm(value, timeFormat);

  // THE DIRTY-FORM REGISTRY LISTENS FOR NATIVE EVENTS ON THE NAMED FIELD ITSELF
  // (#4976), and this field's named element is the hidden sibling below — the
  // VISIBLE input and picker BUTTON the person actually interacts with carry no
  // `name`, so nothing either fires natively ever reaches the registry. Two
  // dispatches stand in, one per event the registry listens for, in the order a
  // real focus-then-edit always produces them:
  //
  //   `focusin`, from `registerDirtyBaseline` below — called from EVERY seam that
  //   precedes an edit, BEFORE any of them has changed `value`, so the hidden
  //   input's DOM value the registry reads at that moment is still the PRE-EDIT
  //   one. That is what lets it register the correct baseline; firing this only
  //   from a synthetic post-commit effect (after `value` had already moved) would
  //   register the field against its own just-edited value and it could never
  //   look dirty. `onFocusIn` is idempotent for an already-registered field, so a
  //   second call mid-edit does not clobber the first baseline.
  //
  //   THE WHEEL IS A SEPARATE SEAM FROM TYPING, and missing it was a real bug
  //   (caught in review, not by a test that existed): opening the picker moves
  //   focus to the button, never to the text input, so a value chosen entirely
  //   by wheel or keyboard never ran through the visible input's `onFocus` at
  //   all — the hidden field went straight to `onEdit`'s never-focused branch,
  //   which registers baseline from `domDefaultValue` at THAT moment, and by
  //   then (a post-commit dispatch) the default had already moved onto the pick.
  //   A picked time therefore read as clean no matter what was chosen. The fix is
  //   the same registration call, made from the wheel's own pre-edit moment: the
  //   button's `onClick`, when it is OPENING (never on close, which precedes no
  //   edit).
  //
  //   `input`, from THIS effect, once per committed `value` change — marks the
  //   already-registered field touched, whichever seam registered it. Skips the
  //   mount's own commit: the hidden input's initial value already equals
  //   `value`, so dispatching then would be a harmless no-op the registry
  //   discards anyway.
  const registerDirtyBaseline = () =>
    hiddenRef.current?.dispatchEvent(new Event("focusin", { bubbles: true }));
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!name) return;
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    hiddenRef.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [name, value]);

  // The native input rejected a malformed time; a text input does not, so the
  // Constraint Validation API carries it (`required` only covers empty).
  useEffect(() => {
    inputRef.current?.setCustomValidity(
      shown && !parseTypedClock(shown)
        ? "Enter a time, like 19:30, 7:30 pm or 730p."
        : ""
    );
  }, [shown]);

  // Close on outside click — the POPOVER's dismissal, and only its. The panel is
  // portaled outside `ref`, so a click inside it must count as inside or picking
  // an hour would close first. The SHEET owns its own (scrim, flick, Escape).
  useEffect(() => {
    if (!open || compact) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !popRef.current?.contains(t))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, compact]);

  return (
    <div
      className="relative"
      ref={ref}
      data-escape-layer={open ? "true" : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
      onBlur={(e) => {
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
        value={shown}
        required={required}
        disabled={disabled}
        aria-label={label}
        placeholder={timeFormat === "24h" ? "hh:mm" : "h:mm am"}
        inputMode="numeric"
        autoComplete="off"
        // The TYPING seam's dirty-form registration moment (#4976) — see the
        // comment above `registerDirtyBaseline` for why it fires here rather
        // than post-edit, and why the wheel needs its own call at its own seam.
        //
        // FOCUS ALSO OPENS THE WHEEL, WHERE IT IS A POPOVER — `DateField`'s rule
        // verbatim (components/DateField.tsx, `onFocus`), because the two halves
        // of `WhenControl` should not answer a tap differently. From `md` up the
        // panel floats beside the field and focus stays in the input, so opening
        // costs the typist nothing. Below `md` the wheel is a modal SHEET that
        // takes focus, and opening it the moment the field is tapped would mean
        // the field could never be typed into on a phone at all; there the glyph
        // stays the door. Opening is not PICKING — the baseline registered above
        // is still only a baseline, so a field merely glanced at stays clean.
        onFocus={() => {
          registerDirtyBaseline();
          if (!compact) setOpen(true);
        }}
        // ±1 MINUTE ON THE ARROWS, the segment stepping the native control had.
        // The field owns no day (that is `WhenControl`'s, #2236), so 23:59 wraps
        // to 00:00 rather than reaching for tomorrow. An empty or unparseable
        // field steps NOWHERE: seeding a time from the clock is the one thing
        // this component never does. `Home`/`End` are left to the wheel's own
        // columns. Clearing the draft is what makes the step visible — the text
        // it was typed as has just stopped being what the field holds.
        onKeyDown={(e) => {
          const step = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
          if (!step) return;
          const hhmm = parseTypedClock(shown);
          if (!hhmm) return;
          e.preventDefault();
          const minutes =
            (Number(hhmm.slice(0, 2)) * 60 +
              Number(hhmm.slice(3)) +
              step +
              1440) %
            1440;
          setDraft(null);
          onChange(`${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`);
        }}
        onChange={(e) => {
          const text = e.target.value;
          const parsed = parseTypedClock(text);
          const emitted = parsed ?? (text.trim() ? null : "");
          // Pinned to the value this keystroke LEAVES the parent holding, so the
          // draft survives its own emission and expires on anyone else's.
          setDraft({ text, from: emitted ?? value });
          if (emitted !== null) onChange(emitted);
        }}
        // A typed time that PARSED settles into the profile's own clock when the
        // field is left; one that did not stays on screen wearing its validity
        // message, because silently discarding what somebody typed is the defect
        // `DateField` avoids the same way.
        onBlur={() =>
          setDraft((d) => (d && parseTypedClock(d.text) ? null : d))
        }
        // `pr-9` matches the picker button's real reach — a 1rem glyph inset
        // 0.5rem — exactly as the date field's calendar button does.
        className={`input pr-9 ${inputClassName}`}
      />
      {/* The visible field can show a friendly clock, so the canonical value is
          submitted via a hidden input for `name` usage — DateField's own pattern.
          `data-dirty-track-hidden` opts THIS hidden input into the dirty-form
          registry, which excludes `type="hidden"` by default (components/
          DirtyFormRegistry.tsx) — this one carries the field's whole value
          rather than plumbing, so it is the one hidden input asking to be seen. */}
      {name && (
        <input
          ref={hiddenRef}
          type="hidden"
          name={name}
          value={value}
          data-dirty-track-hidden="true"
        />
      )}
      <button
        type="button"
        // The WHEEL seam's dirty-form registration moment (#4976): the button
        // taking focus is the pre-edit moment for a picked value, since nothing
        // else here ever focuses the visible input. Only on OPEN — closing
        // precedes no edit, and re-registering on every toggle is needless
        // (idempotent, but the moment is what matters, not the repetition).
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) registerDirtyBaseline();
        }}
        disabled={disabled}
        aria-label="Open time picker"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-600 disabled:opacity-40 dark:text-slate-400 dark:hover:text-slate-300"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="h-4 w-4"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
      </button>

      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        title="Choose a time"
        testId="time-field-wheel"
        sheetTestId="time-field-sheet"
        panelRef={popRef}
        fallbackWidth={PANEL_WIDTH}
        panelClassName="w-56 p-3"
        popoverZIndexClass="z-70"
        sheetZIndexClass="z-70"
        // The field keeps its own outside-click and blur handling, so a
        // full-viewport catcher here would swallow the click that moves to the
        // NEXT field instead of letting it land.
        backdrop={false}
        escapeLayer
      >
        {() => <TimeWheel value={value} onChange={onChange} />}
      </AnchoredPanel>
    </div>
  );
}

const PANEL_WIDTH = 224; // matches w-56

/** Canonical "HH:MM" in the profile's clock, or "" — what the field shows. */
function formatHhmm(value: string, timeFormat: TimeFormat): string {
  const hhmm = parseClockHhmm(value);
  if (!hhmm) return "";
  return formatClock(
    timeFormat,
    Number(hhmm.slice(0, 2)),
    Number(hhmm.slice(3))
  );
}

// ── THE WHEEL ───────────────────────────────────────────────────────────────
//
// Two or three columns, each a real scroll container with `scroll-snap-type: y
// mandatory` and centre-aligned cells. Nothing here animates or recognizes a
// gesture: the browser's own momentum and detents do the work, which is what
// makes it feel like the platform's picker instead of a list that jumps.
//
// THE ROW IS THE TARGET, so it is rendered at the tap floor rather than at the
// control box plus a coarse-pointer reach. The reach idiom needs an isolated
// axis to spend itself on (app/globals.css, SECTION: Touch tap targets) and a
// wheel tiles on the block axis with no gap — by construction, since a gap
// between detents is a wheel with holes in it. A `<select>` and a typed field
// take the box as their target for the same "no room to repair" reason.
const CELL_PX = 44;
/** Odd, so exactly one row sits on the centre line. */
const VISIBLE_ROWS = 5;
const WHEEL_PX = CELL_PX * VISIBLE_ROWS;
/** Half-wheel spacers, so the first and last cell can reach the centre line. */
const PAD_PX = (WHEEL_PX - CELL_PX) / 2;
/**
 * Quiet time, in ms, that reads a flick as finished. `scrollend` would say it
 * exactly, but it is not carried everywhere the app runs, and a wheel that only
 * commits on some browsers is worse than one that always waits a beat. Sized
 * above a frame budget and below a deliberate pause.
 */
const SETTLE_MS = 120;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The columns a clock needs: 24h shows hour+minute, 12h adds the meridiem. */
export function TimeWheel({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const { timeFormat } = useFormatPrefs();
  const twelve = timeFormat === "12h";
  const hhmm = parseClockHhmm(value);
  // An unset wheel RESTS at the top of each column and marks nothing selected —
  // it never proposes a time (#2053). Picking any column composes the whole
  // value from where the others are resting, which is the honest reading of
  // "the user chose this minute".
  const h24 = hhmm ? Number(hhmm.slice(0, 2)) : 0;
  const minute = hhmm ? hhmm.slice(3) : "00";
  const meridiem = h24 >= 12 ? "PM" : "AM";
  const hour = twelve ? pad2(h24 % 12 === 0 ? 12 : h24 % 12) : pad2(h24);

  const emit = (next: {
    hour?: string;
    minute?: string;
    meridiem?: string;
  }) => {
    const h = next.hour ?? hour;
    const m = next.minute ?? minute;
    const ap = next.meridiem ?? meridiem;
    if (!twelve) return onChange(`${h}:${m}`);
    const base = Number(h) % 12;
    return onChange(`${pad2(ap === "PM" ? base + 12 : base)}:${m}`);
  };

  return (
    // The detent band and the edge fades are PAINT, and they live out here
    // rather than inside a column: an absolutely-positioned child of a scroll
    // container scrolls with its content, so a fade drawn in there would ride
    // away with the hours it is meant to be fading.
    <div className="relative flex items-stretch justify-center gap-1">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 rounded-lg bg-slate-500/10 dark:bg-white/10"
        style={{ height: CELL_PX }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-linear-to-b from-surface to-transparent"
        style={{ height: PAD_PX }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-surface to-transparent"
        style={{ height: PAD_PX }}
      />
      <WheelColumn
        label="Hour"
        testId="time-wheel-hour"
        options={
          twelve
            ? Array.from({ length: 12 }, (_, i) => pad2(i + 1))
            : Array.from({ length: 24 }, (_, i) => pad2(i))
        }
        value={hour}
        selected={hhmm !== null}
        onSelect={(hourValue) => emit({ hour: hourValue })}
      />
      <WheelColumn
        label="Minute"
        testId="time-wheel-minute"
        options={Array.from({ length: 60 }, (_, i) => pad2(i))}
        value={minute}
        selected={hhmm !== null}
        onSelect={(minuteValue) => emit({ minute: minuteValue })}
      />
      {twelve ? (
        <WheelColumn
          label="AM or PM"
          testId="time-wheel-meridiem"
          options={["AM", "PM"]}
          value={meridiem}
          selected={hhmm !== null}
          onSelect={(ap) => emit({ meridiem: ap })}
        />
      ) : null}
    </div>
  );
}

function WheelColumn({
  label,
  testId,
  options,
  value,
  selected,
  onSelect,
}: {
  label: string;
  testId: string;
  options: string[];
  value: string;
  /** Whether the field HAS a time — an unset wheel rests without a selection. */
  selected: boolean;
  onSelect: (next: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(0, options.indexOf(value));
  // A flick in progress owns the scroll offset; re-parking mid-momentum would
  // yank the column out from under the finger.
  const flicking = useRef(false);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Park the column on its value — on open, and whenever the value moves from
  // anywhere but this column's own scroll. `scrollTop = index * CELL_PX` puts
  // that cell on the centre line, because the spacers are exactly half a wheel.
  useEffect(() => {
    const el = ref.current;
    if (!el || flicking.current) return;
    el.scrollTop = index * CELL_PX;
  }, [index]);

  useEffect(
    () => () => void (settle.current && clearTimeout(settle.current)),
    []
  );

  const move = (to: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, to))];
    if (next !== value) onSelect(next);
  };

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      tabIndex={0}
      data-testid={testId}
      onScroll={() => {
        flicking.current = true;
        if (settle.current) clearTimeout(settle.current);
        settle.current = setTimeout(() => {
          flicking.current = false;
          const el = ref.current;
          if (!el) return;
          const i = Math.min(
            options.length - 1,
            Math.max(0, Math.round(el.scrollTop / CELL_PX))
          );
          // Only a MOVE is a choice. Parking the column on its own value fires a
          // scroll event too, and committing that would make opening the picker
          // look like using it.
          if (options[i] !== value) onSelect(options[i]);
        }, SETTLE_MS);
      }}
      onKeyDown={(e) => {
        const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
        if (step) {
          e.preventDefault();
          move(index + step);
        } else if (e.key === "Home") {
          e.preventDefault();
          move(0);
        } else if (e.key === "End") {
          e.preventDefault();
          move(options.length - 1);
        }
      }}
      // `snap-y snap-mandatory` on the scroller and `snap-center` on the cells is
      // the whole mechanism. The edge fades below are paint only.
      className="relative snap-y snap-mandatory overflow-y-auto overscroll-contain rounded-lg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500"
      style={{ height: WHEEL_PX, scrollbarWidth: "none" }}
    >
      <div style={{ height: PAD_PX }} aria-hidden />
      {options.map((option) => {
        const isValue = selected && option === value;
        return (
          <button
            key={option}
            type="button"
            role="option"
            aria-selected={isValue}
            tabIndex={-1}
            onClick={() => {
              // A TAP IS THE EXPLICIT CHOICE AND OUTRANKS A SCROLL IN FLIGHT.
              // The parking effect above stands down while `flicking`, so a row
              // tapped mid-momentum left the column resting where the flick put
              // it — and the pending settle then committed THAT over the row the
              // finger hit. Cancelling the settle, clearing the flag and parking
              // the column here makes the tap authoritative. Parking explicitly
              // rather than leaving it to the effect also covers tapping the row
              // that is ALREADY the value, where the index never changes and the
              // effect would never run.
              if (settle.current) clearTimeout(settle.current);
              flicking.current = false;
              if (ref.current)
                ref.current.scrollTop = options.indexOf(option) * CELL_PX;
              onSelect(option);
            }}
            style={{ height: CELL_PX }}
            className={`flex w-14 snap-center items-center justify-center text-base tabular-nums transition ${
              isValue
                ? "font-semibold text-brand-600 dark:text-brand-400"
                : "text-slate-600 dark:text-slate-300"
            }`}
          >
            {option}
          </button>
        );
      })}
      <div style={{ height: PAD_PX }} aria-hidden />
    </div>
  );
}
