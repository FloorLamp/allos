"use client";

import DateField from "../DateField";
import { nowHHMM } from "./model";

// The activity form's date + start/end time fields, with the "now" shortcut and
// the time-error / duration hints. Presentational only — extracted from
// ActivityForm so the parent stays composition (#319).
export default function DateTimeFields({
  date,
  startTime,
  endTime,
  tz,
  timeError,
  overallDuration,
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
  onDate: (v: string) => void;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
}) {
  return (
    <>
      {/* Date and times */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label">Date</label>
          <DateField value={date} onChange={onDate} required />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0">Start</label>
            {startTime !== nowHHMM(tz) && (
              <button
                type="button"
                onClick={() => onStartTime(nowHHMM(tz))}
                className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                now
              </button>
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
          <label className="label">End</label>
          <input
            type="time"
            value={endTime}
            min={startTime || undefined}
            onChange={(e) => onEndTime(e.target.value)}
            className={`input ${timeError ? "border-rose-300 dark:border-rose-800" : ""}`}
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
