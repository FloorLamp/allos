"use client";

import DateField from "@/components/DateField";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz, zonedDateParts } from "@/lib/date";
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
//      physically cannot hand it `recorded_at ?? taken_at` and have it read as a
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
// whether a time is required in `state` mode, and the labels. The raw
// <input type="time"> lives HERE and nowhere else — a scan
// (lib/__tests__/time-input-scan.test.ts) fails any new one outside this file.
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

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
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
        <input
          type="time"
          value={hhmm}
          onChange={(e) => setHhmm(e.target.value)}
          required={mode === "state" && timeRequired}
          disabled={disabled}
          className="input h-8 w-28 text-sm"
          id={`${testId}-time`}
          aria-label={timeLabel}
          title={timeLabel}
          data-testid={`${testId}-time`}
        />
      ) : (
        <select
          value={value.statedAt ?? ""}
          onChange={(e) => {
            const iso = e.target.value;
            onChange({ date: value.date, statedAt: iso === "" ? null : iso });
          }}
          required={mode === "state" && timeRequired}
          disabled={disabled}
          className="input h-8 w-32 text-sm"
          id={`${testId}-time`}
          aria-label={timeLabel}
          title={timeLabel}
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
          {pinned ? <option value={pinned.iso}>{pinned.hhmm}</option> : null}
          {hourOptions.map((o) => (
            <option key={o.iso} value={o.iso}>
              {o.hhmm}
            </option>
          ))}
        </select>
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
