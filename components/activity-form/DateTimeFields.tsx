"use client";

import DateField from "../DateField";
import { nowHHMM } from "./model";
import { shiftHHMM } from "@/lib/activity-meta";
import { dateStrInTz, hourInTz, shiftDateStr } from "@/lib/date";

// The activity form's date + start/end time fields, with the "now" shortcuts,
// Start↔End derivation, the post-midnight date nudge, and the time-error /
// duration hints. Presentational only — extracted from ActivityForm so the
// parent stays composition (#319).
export default function DateTimeFields({
  date,
  startTime,
  endTime,
  tz,
  timeError,
  overallDuration,
  derivableDurationMin,
  onDate,
  onStartTime,
  onEndTime,
}: {
  date: string;
  startTime: string;
  endTime: string;
  tz: string;
  timeError: boolean;
  overallDuration: number | null;
  // A cardio/sport part's Duration (min), used to derive the third of
  // {start, end, duration} when the other two are known (#336). null when no
  // usable part duration is entered.
  derivableDurationMin: number | null;
  onDate: (v: string) => void;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
}) {
  // Derive End = Start + duration (or Start = End − duration) when two of the
  // three are known and the result stays in-day (#336).
  const derivedEnd =
    startTime && !endTime && derivableDurationMin != null
      ? shiftHHMM(startTime, derivableDurationMin)
      : null;
  const derivedStart =
    endTime && !startTime && derivableDurationMin != null
      ? shiftHHMM(endTime, -derivableDurationMin)
      : null;
  // Post-midnight nudge (#336): a session finished at 00:15 usually belongs to
  // yesterday. In the small hours (before 4am), if the date is still today,
  // offer a one-tap switch to yesterday.
  const yesterday = shiftDateStr(dateStrInTz(tz), -1);
  const showYesterdayNudge = hourInTz(tz) < 4 && date === dateStrInTz(tz);
  return (
    <>
      {/* Date and times */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0">Date</label>
            {showYesterdayNudge && (
              <button
                type="button"
                onClick={() => onDate(yesterday)}
                className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                yesterday?
              </button>
            )}
          </div>
          <div className="mt-1">
            <DateField value={date} onChange={onDate} required />
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0">Start</label>
            {derivedStart ? (
              <button
                type="button"
                onClick={() => onStartTime(derivedStart)}
                title={`Set start to end − ${derivableDurationMin} min`}
                className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                −{derivableDurationMin}m
              </button>
            ) : (
              startTime !== nowHHMM(tz) && (
                <button
                  type="button"
                  onClick={() => onStartTime(nowHHMM(tz))}
                  className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  now
                </button>
              )
            )}
          </div>
          <input
            type="time"
            value={startTime}
            onChange={(e) => onStartTime(e.target.value)}
            className="input mt-1"
          />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0">End</label>
            {derivedEnd ? (
              <button
                type="button"
                onClick={() => onEndTime(derivedEnd)}
                title={`Set end to start + ${derivableDurationMin} min`}
                className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                +{derivableDurationMin}m
              </button>
            ) : (
              endTime !== nowHHMM(tz) && (
                <button
                  type="button"
                  onClick={() => onEndTime(nowHHMM(tz))}
                  className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  now
                </button>
              )
            )}
          </div>
          <input
            type="time"
            value={endTime}
            min={startTime || undefined}
            onChange={(e) => onEndTime(e.target.value)}
            className={`input mt-1 ${timeError ? "border-rose-300 dark:border-rose-800" : ""}`}
          />
        </div>
      </div>
      {timeError && (
        <p className="-mt-2 text-xs text-rose-500 dark:text-rose-400">
          End time must be after the start time.
        </p>
      )}
      {!timeError && overallDuration != null && (
        <p className="-mt-2 text-xs text-slate-400 dark:text-slate-500">
          Duration: {overallDuration} min
        </p>
      )}
    </>
  );
}
