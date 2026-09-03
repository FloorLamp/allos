"use client";

import DateField from "../DateField";
import TimeRangeFields from "../TimeRangeFields";
import { dateStrInTz, hourInTz, shiftDateStr } from "@/lib/date";

// The activity form's date + duration column and the post-midnight date nudge,
// beside the shared start/end pair. Presentational only — extracted from
// ActivityForm so the parent stays composition (#319).
//
// THE PAIR ITSELF IS NO LONGER HERE (#4384 fix 6): the "now" shortcuts, the
// Start↔End derivation and the End-before-Start message moved to
// `components/TimeRangeFields.tsx`, which the practice form mounts too. What
// stays is what is genuinely the ACTIVITY's — the date, its yesterday nudge, and
// the session Duration that the parts feed and the clock span derives.
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
                className="-mx-2 -my-2 px-2 py-2 text-xs text-link"
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
                onChange={(e) => onSessionDuration(e.target.value)}
                className={`input pr-9 ${
                  durationDerived ? "text-slate-500 dark:text-slate-400" : ""
                } ${durationError ? "border-rose-300 dark:border-rose-800" : ""}`}
              />
              <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
                min
              </span>
            </div>
            {durationDerived && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Calculated from start and end.
              </p>
            )}
            {durationError && (
              <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
                Total must cover timed components.
              </p>
            )}
          </div>
        )}
      </div>
      <TimeRangeFields
        idPrefix="activity"
        startTime={startTime}
        endTime={endTime}
        tz={tz}
        timeError={timeError}
        derivableDurationMin={derivableDurationMin}
        onStartTime={onStartTime}
        onEndTime={onEndTime}
      />
    </div>
  );
}
