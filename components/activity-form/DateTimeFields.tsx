"use client";

import DateField from "../DateField";
import { nowHHMM } from "./model";
import { shiftHHMM } from "@/lib/activity-meta";
import { dateStrInTz, hourInTz, shiftDateStr } from "@/lib/date";

// The activity form's date + start/end time fields, with the "now" shortcuts,
// Start↔End derivation, the post-midnight date nudge, and the time-error /
// duration controls. Presentational only — extracted from ActivityForm so the
// parent stays composition (#319).
export default function DateTimeFields({
  date,
  startTime,
  endTime,
  tz,
  timeError,
  dateError,
  showSessionDuration,
  sessionDuration,
  durationDerived,
  durationError,
  derivableDurationMin,
  onDate,
  onStartTime,
  onEndTime,
  onSessionDuration,
}: {
  date: string;
  startTime: string;
  endTime: string;
  tz: string;
  timeError: boolean;
  dateError: boolean;
  showSessionDuration: boolean;
  sessionDuration: string;
  durationDerived: boolean;
  durationError: boolean;
  // A cardio/sport part's Duration (min), used to derive the third of
  // {start, end, duration} when the other two are known (#336). null when no
  // usable part duration is entered.
  derivableDurationMin: number | null;
  onDate: (v: string) => void;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
  onSessionDuration: (v: string) => void;
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
    <div data-testid="date-time-fields" className="grid gap-3 sm:grid-cols-2">
      {/* Date and total duration share the compact left column; the clock range
          reads as one paired field on the right. */}
      <div className={showSessionDuration ? "grid grid-cols-2 gap-2" : ""}>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="label mb-0" htmlFor="activity-date">
              Date
            </label>
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
            <DateField
              id="activity-date"
              value={date}
              onChange={onDate}
              inputClassName="bg-white dark:bg-ink-900"
              required
            />
          </div>
          {dateError && (
            <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
              Enter a valid date (YYYY-MM-DD).
            </p>
          )}
        </div>
        {showSessionDuration && (
          <div>
            <label className="label mb-0" htmlFor="activity-duration">
              Duration
            </label>
            <div className="relative mt-1">
              <input
                id="activity-duration"
                data-testid="activity-duration"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={sessionDuration}
                readOnly={durationDerived}
                title={
                  durationDerived ? "Calculated from start and end" : undefined
                }
                onChange={(e) => onSessionDuration(e.target.value)}
                className={`input h-[38px] bg-white pr-9 dark:bg-ink-900 ${
                  durationDerived ? "text-slate-500 dark:text-slate-400" : ""
                } ${durationError ? "border-rose-300 dark:border-rose-800" : ""}`}
              />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
                min
              </span>
            </div>
            {durationError && (
              <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
                Total must cover timed components.
              </p>
            )}
          </div>
        )}
      </div>
      <div data-testid="time-range-fields">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="flex items-baseline gap-2">
              <label className="label mb-0" htmlFor="activity-start-time">
                Start
              </label>
              {derivedStart ? (
                <button
                  type="button"
                  data-testid="start-time-shortcut"
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
                    data-testid="start-time-shortcut"
                    onClick={() => onStartTime(nowHHMM(tz))}
                    className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    now
                  </button>
                )
              )}
            </div>
            <input
              id="activity-start-time"
              type="time"
              value={startTime}
              onChange={(e) => onStartTime(e.target.value)}
              className="input mt-1 h-[38px] bg-white dark:bg-ink-900"
            />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <label className="label mb-0" htmlFor="activity-end-time">
                End
              </label>
              {derivedEnd ? (
                <button
                  type="button"
                  data-testid="end-time-shortcut"
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
                    data-testid="end-time-shortcut"
                    onClick={() => onEndTime(nowHHMM(tz))}
                    className="-mx-2 -my-2 px-2 py-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
                  >
                    now
                  </button>
                )
              )}
            </div>
            <input
              id="activity-end-time"
              type="time"
              data-testid="end-time-input"
              value={endTime}
              min={startTime || undefined}
              onChange={(e) => onEndTime(e.target.value)}
              className={`input mt-1 h-[38px] bg-white dark:bg-ink-900 ${timeError ? "border-rose-300 dark:border-rose-800" : ""}`}
            />
          </div>
        </div>
        {timeError && (
          <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
            End time must be after the start time.
          </p>
        )}
      </div>
    </div>
  );
}
