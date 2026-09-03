"use client";

import { nowHHMM } from "@/lib/activity-form-model";
import { shiftHHMM } from "@/lib/activity-meta";
import TimeField from "@/components/TimeField";

// THE HOUSE START/END PAIR (#4384 fix 6), extracted from the activity form's
// `DateTimeFields`. #336's interplay — a "now" on each clock, a ±duration offer when
// the other clock and a duration are both known, and the End-before-Start message —
// was solved once for activities and then not reused: the practice form shipped a bare
// uncoupled pair, so the same two clocks meant different things depending on which
// door you opened them behind. The pair is ONE component now and both domains mount
// it. #3295's substance spans are its next tenant. #4218's TimeField landed here
// (#4976): both clocks are `TimeField` now, restyled once rather than in each host —
// which is also why the native `min` attribute on End is gone (it was the browser's
// own constraint; `timeError` below was always the real refusal).
//
// THE TWO CLOCKS ARE THE WHOLE OF IT. The DAY belongs to the surface (the form's
// DateField, the row's date, the card's day context) and the DURATION belongs to the
// domain — this component only READS a duration to know what its ± offers are worth,
// and tells the host what the pair implies through `timeError`, whose refusal is the
// host's to make on its own submit.
export default function TimeRangeFields({
  idPrefix,
  startTime,
  endTime,
  tz,
  timeError,
  derivableDurationMin,
  startName,
  endName,
  onStartTime,
  onEndTime,
}: {
  /** Names the inputs `{idPrefix}-start-time` / `{idPrefix}-end-time`, which is what
   *  each visible label points at. Host-supplied because two mounts can share a page. */
  idPrefix: string;
  startTime: string;
  endTime: string;
  tz: string;
  /** End before Start — drawn here, refused by the host's submit. */
  timeError: boolean;
  /** What the ± shortcuts are worth, or null when no duration is stated (#336). */
  derivableDurationMin: number | null;
  /** Set where the host posts the pair through FormData rather than from its state. */
  startName?: string;
  endName?: string;
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
  return (
    <div data-testid="time-range-fields">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="flex items-baseline gap-2">
            <label className="label mb-0" htmlFor={`${idPrefix}-start-time`}>
              Start
            </label>
            {derivedStart ? (
              <button
                type="button"
                data-testid="start-time-shortcut"
                onClick={() => onStartTime(derivedStart)}
                aria-label={`−${derivableDurationMin}m — set start to end − ${derivableDurationMin} min`}
                className="-mx-2 -my-2 px-2 py-2 text-xs text-link"
              >
                −{derivableDurationMin}m
              </button>
            ) : (
              startTime !== nowHHMM(tz) && (
                <button
                  type="button"
                  data-testid="start-time-shortcut"
                  onClick={() => onStartTime(nowHHMM(tz))}
                  className="-mx-2 -my-2 px-2 py-2 text-xs text-link"
                >
                  now
                </button>
              )
            )}
          </div>
          <TimeField
            id={`${idPrefix}-start-time`}
            name={startName}
            value={startTime}
            onChange={onStartTime}
            label="Start"
            inputClassName="mt-1"
          />
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <label className="label mb-0" htmlFor={`${idPrefix}-end-time`}>
              End
            </label>
            {derivedEnd ? (
              <button
                type="button"
                data-testid="end-time-shortcut"
                onClick={() => onEndTime(derivedEnd)}
                aria-label={`+${derivableDurationMin}m — set end to start + ${derivableDurationMin} min`}
                className="-mx-2 -my-2 px-2 py-2 text-xs text-link"
              >
                +{derivableDurationMin}m
              </button>
            ) : (
              endTime !== nowHHMM(tz) && (
                <button
                  type="button"
                  data-testid="end-time-shortcut"
                  onClick={() => onEndTime(nowHHMM(tz))}
                  className="-mx-2 -my-2 px-2 py-2 text-xs text-link"
                >
                  now
                </button>
              )
            )}
          </div>
          <TimeField
            id={`${idPrefix}-end-time`}
            name={endName}
            data-testid="end-time-input"
            value={endTime}
            onChange={onEndTime}
            label="End"
            inputClassName={`mt-1 ${timeError ? "border-rose-300 dark:border-rose-800" : ""}`}
          />
        </div>
      </div>
      {timeError && (
        <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
          End time must be after the start time.
        </p>
      )}
    </div>
  );
}
