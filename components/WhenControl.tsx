"use client";

import { useRef, useState } from "react";
import AnchoredPanel from "@/components/overlay/AnchoredPanel";
import DateField from "@/components/DateField";
import MonthCalendar from "@/components/MonthCalendar";
import TimeField, { TimeWheel } from "@/components/TimeField";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz, zonedDateParts } from "@/lib/date";
import { formatClock, formatWeekdayDate } from "@/lib/format-date";
import {
  reanchorStatedAt,
  statedHhmm,
  statedHoursOnDate,
  statedInstantOnDate,
  type WhenValue,
} from "@/lib/stated-time";

export type { WhenValue } from "@/lib/stated-time";

// ONE "when did this happen?" control (issue #2236): the date + time PAIR of an
// OBSERVED event, owned together. Ten hand-rolled event-time inputs asked this
// question in four vocabularies; this control is the one they converge on, and the
// three filed consumers (#2227 food correction, #2228 dose amend, #2235
// measurements) build their input halves on it instead of shipping an eleventh.
//
// ── the invariants the control owns (its callers cannot break them) ─────────
//
//   1. THE PAIR IS ONE VALUE. A stated instant's profile-local date IS the row's
//      `date`: every time choice is anchored on the current date, and a date
//      change re-anchors (or clears — never invents) the stated instant. Two
//      independent widgets cannot enforce a property of the pair; one can.
//   2. `statedAt: string | null`, NEVER a pre-coalesced string. A caller
//      physically cannot hand it `recorded_at` and have it read as a
//      statement — null renders empty and means "not stated" (#2228's laundering
//      defect made unrepresentable rather than merely fixed once).
//   3. IT NEVER DEFAULTS TO NOW, AND OFFERS "NOW" (#2053). An untouched time
//      field stays empty; the one-tap "Now" fills an absolute local time, and is
//      only offered while the chosen day is today.
//   4. ABSOLUTE LOCAL TIMES, ALWAYS. No relative offsets on a rendered page: a
//      "-1h" chip is computed at tap time and drifts with every minute the page
//      sits open; "13:00" cannot (lib/correction-time.ts's argument, applied).
//
// ── what stays the DOMAIN's, via props ──────────────────────────────────────
//
// Bounds (a course window, a bounded recent-days list, max-today), grain,
// whether a time is required in `state` mode, and the labels.
//
// THERE IS NO RAW <input type="time"> LEFT (#4218). The minute grain renders
// components/TimeField.tsx — the styled sibling `DateField` already was for
// dates — so this file is no longer the scan's exempt home either; the ratchet
// in lib/__tests__/time-input-scan.test.ts kept its exemption for exactly as
// long as the control needed one.
//
// AND WHEN A TIME IS THE POINT OF THE SUBMISSION, THE PAIR IS ONE DOOR. A
// `state` mount that REQUIRES a time on a day the user may still change is
// stating one value (invariant 1) through two fields and two dismissals; those
// mounts render one composed field over one panel holding the same calendar and
// the same wheel. Optional-time and `correct` mounts keep the split fields
// deliberately: an empty time field at rest is the honest "no time stated", and
// "Not stated" plus one-half edits are what a correction surface is for.
export interface WhenControlProps {
  // `state` — an assertion (a backfill, a create): "Not stated" is not offered,
  //   and the domain decides via `timeRequired` whether naming a time is the
  //   point of the submission. An empty, not-required time emits null — never a
  //   defaulted now.
  // `correct` — an amendment: "Not stated" is ALWAYS offered, and choosing it
  //   emits null. NULL means nobody said; a correction surface that can reach
  //   every state except back to the honest default is a one-way ratchet into a
  //   guess.
  mode: "state" | "correct";
  // `hour` renders an enumerated select of the chosen day's hours (truncated at
  // the current hour when the day is today); `minute` renders a time input.
  // Both emit the same `{ date, statedAt }`.
  grain: "hour" | "minute";
  value: WhenValue;
  onChange: (next: WhenValue) => void;
  // The profile timezone that decides which day an instant belongs to. Defaults
  // to the app-wide TimezoneProvider (the acting profile); a cross-profile host
  // passes the TARGET profile's zone explicitly.
  tz?: string;
  // state mode only: refuse to leave the time empty (the input turns required;
  // the caller still gates its own submit on `statedAt !== null`).
  timeRequired?: boolean;
  // Inclusive ISO day bounds, the domain's policy. When min === max the day is
  // FIXED: the control renders it as text (today reads "Today") instead of a
  // picker, and the pair rule holds trivially.
  minDate?: string;
  maxDate?: string;
  dateLabel?: string;
  timeLabel?: string;
  disabled?: boolean;
  // Prefix for stable ids/test ids: `{testId}-date`, `{testId}-time`,
  // `{testId}-now`, `{testId}-not-stated`.
  testId: string;
}

export default function WhenControl({
  mode,
  grain,
  value,
  onChange,
  tz: tzProp,
  timeRequired = false,
  minDate,
  maxDate,
  dateLabel = "Date",
  timeLabel = "Time",
  disabled = false,
  testId,
}: WhenControlProps) {
  const contextTz = useTimezone();
  const tz = tzProp ?? contextTz;
  // The client clock, read per render: "today" gates the Now offer and truncates
  // the hour offer. The e2e harness freezes the browser clock alongside the
  // server's (see e2e/fixtures.ts), so the two agree there too.
  const now = new Date();
  const today = dateStrInTz(tz, now);
  const fixedDay = minDate !== undefined && minDate === maxDate;

  const setDate = (date: string) => {
    // The pair moves together: a date change re-anchors the stated instant onto
    // the new day (or clears it — never invents one), so the two fields cannot
    // come apart even mid-edit.
    onChange({
      date,
      statedAt: reanchorStatedAt(value.statedAt, date, tz, now),
    });
  };

  const setHhmm = (hhmm: string) => {
    if (!hhmm) {
      onChange({ date: value.date, statedAt: null });
      return;
    }
    // Anchored on the CURRENT date — the only way a time can enter the value —
    // so the stated instant's local day is the row's day by construction.
    const inst = statedInstantOnDate(value.date, hhmm, tz);
    onChange({ date: value.date, statedAt: inst ? inst.toISOString() : null });
  };

  const fillNow = () => {
    // The one-tap "now": an ABSOLUTE local time, filled into the field so the
    // user sees (and can adjust) exactly what will be stated. Minute precision;
    // only offered while the chosen day is today, so the pair rule holds.
    onChange({
      date: value.date,
      statedAt:
        statedInstantOnDate(
          value.date,
          zonedDateParts(tz, now).hhmm,
          tz
        )?.toISOString() ?? null,
    });
  };

  const hhmm = statedHhmm(value.statedAt, tz);
  const hourOptions =
    grain === "hour" ? statedHoursOnDate(value.date, tz, now) : [];
  // A stored statement that is not one of the offered hours (a minute-precision
  // instant being corrected at hour grain, or a "Now" fill) still renders as
  // itself — pinned as an extra option rather than silently rounded.
  const pinned =
    grain === "hour" &&
    value.statedAt !== null &&
    !hourOptions.some((o) => o.iso === value.statedAt)
      ? { hhmm, iso: value.statedAt }
      : null;

  // ONE DOOR when the pair is one required value — see the header. A FIXED day is
  // excluded because there is no day to pick: the control renders it as text, so
  // a composed field would be a picker for half of itself.
  const combined =
    grain === "minute" && mode === "state" && timeRequired && !fixedDay;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      {combined ? (
        <WhenDoor
          date={value.date}
          hhmm={hhmm}
          onDate={setDate}
          onHhmm={setHhmm}
          min={minDate}
          max={maxDate}
          disabled={disabled}
          label={`${dateLabel} and ${timeLabel.toLowerCase()}`}
          testId={testId}
        />
      ) : (
        <>
          {fixedDay ? (
            <span
              className="text-sm text-slate-600 dark:text-slate-300"
              data-testid={`${testId}-date`}
            >
              {value.date === today ? "Today" : value.date}
            </span>
          ) : (
            <label className="block">
              <span className="sr-only">{dateLabel}</span>
              <DateField
                value={value.date}
                onChange={setDate}
                min={minDate}
                max={maxDate}
                required
                id={`${testId}-date`}
                inputClassName="h-8 w-36 text-sm"
                data-testid={`${testId}-date`}
              />
            </label>
          )}
          {grain === "minute" ? (
            <TimeField
              value={hhmm}
              onChange={setHhmm}
              required={mode === "state" && timeRequired}
              disabled={disabled}
              inputClassName="w-32 text-sm"
              id={`${testId}-time`}
              label={timeLabel}
              data-testid={`${testId}-time`}
            />
          ) : (
            <select
              value={value.statedAt ?? ""}
              onChange={(e) => {
                const iso = e.target.value;
                onChange({
                  date: value.date,
                  statedAt: iso === "" ? null : iso,
                });
              }}
              required={mode === "state" && timeRequired}
              disabled={disabled}
              className="input w-32 text-sm"
              id={`${testId}-time`}
              aria-label={timeLabel}
              data-testid={`${testId}-time`}
            >
              {mode === "correct" ? (
                // The honest default stays reachable: choosing it emits null.
                <option value="">Not stated</option>
              ) : timeRequired ? (
                <option value="" disabled>
                  Select time
                </option>
              ) : (
                <option value="">No time</option>
              )}
              {pinned ? (
                <option value={pinned.iso}>{pinned.hhmm}</option>
              ) : null}
              {hourOptions.map((o) => (
                <option key={o.iso} value={o.iso}>
                  {o.hhmm}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      {value.date === today ? (
        <button
          type="button"
          onClick={fillNow}
          disabled={disabled}
          className="btn-ghost btn-sm"
          data-testid={`${testId}-now`}
        >
          Now
        </button>
      ) : null}
      {mode === "correct" && grain === "minute" ? (
        <button
          type="button"
          onClick={() => onChange({ date: value.date, statedAt: null })}
          disabled={disabled || value.statedAt === null}
          className="btn-ghost btn-sm"
          data-testid={`${testId}-not-stated`}
        >
          Not stated
        </button>
      ) : null}
    </div>
  );
}

// The composed field the combined door renders, and its one panel. Nothing here
// is a new primitive: the calendar is `MonthCalendar` — the same grid the date
// field opens — and the wheel is `TimeField`'s, imported rather than re-drawn.
// What this adds is the composition, which is `WhenControl`'s to make because
// the pair is `WhenControl`'s to own.
//
// PICKING A DAY DOES NOT CLOSE IT, unlike the date field's own calendar: the
// panel exists to state BOTH halves, so closing on the first would put the user
// back through the door for the second. It closes on Done, on Escape, on the
// scrim, and — below `md` — on the sheet's own flick.
//
// KNOWN COST, ACCEPTED (#4218): the phone sheet is tall, calendar above wheel,
// and it ships as one scrollable sheet rather than a two-step.
function WhenDoor({
  date,
  hhmm,
  onDate,
  onHhmm,
  min,
  max,
  disabled,
  label,
  testId,
}: {
  date: string;
  hhmm: string;
  onDate: (next: string) => void;
  onHhmm: (next: string) => void;
  min?: string;
  max?: string;
  disabled: boolean;
  label: string;
  testId: string;
}) {
  const prefs = useFormatPrefs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        id={`${testId}-when`}
        data-testid={`${testId}-when`}
        className="input w-full text-left text-sm sm:w-64"
      >
        {formatWeekdayDate(date, prefs)}
        {hhmm ? (
          <>
            {" \u00b7 "}
            {formatClock(
              prefs.timeFormat,
              Number(hhmm.slice(0, 2)),
              Number(hhmm.slice(3))
            )}
          </>
        ) : (
          // The time is REQUIRED here, so an empty one is not "not stated" — it
          // is the half of the value still owed.
          <span className="text-slate-500 dark:text-slate-400">
            {" \u00b7 add a time"}
          </span>
        )}
      </button>
      <AnchoredPanel
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        title="Choose a date and time"
        role="dialog"
        testId={`${testId}-when-panel`}
        sheetTestId={`${testId}-when-sheet`}
        fallbackWidth={288}
        panelClassName="w-72 p-3"
        popoverZIndexClass="z-70"
        sheetZIndexClass="z-70"
        escapeLayer
      >
        {() => (
          <>
            <MonthCalendar
              binding={{
                kind: "selectable",
                value: date,
                min,
                max,
                onSelect: onDate,
              }}
            />
            <div className="mt-2 border-t border-black/10 pt-2 dark:border-white/10">
              <TimeWheel value={hhmm} onChange={onHhmm} />
            </div>
            <div className="mt-2 flex justify-end border-t border-black/10 pt-2 text-sm dark:border-white/10">
              <button
                type="button"
                onClick={() => setOpen(false)}
                data-testid={`${testId}-when-done`}
                className="py-3 font-medium text-brand-600 hover:text-brand-700 md:py-0 dark:text-brand-400 dark:hover:text-brand-300"
              >
                Done
              </button>
            </div>
          </>
        )}
      </AnchoredPanel>
    </div>
  );
}
