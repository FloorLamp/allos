"use client";

import { nowHHMM } from "@/lib/activity-form-model";
import { overnightMinutesBetween, shiftHHMM } from "@/lib/activity-meta";
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
//
// LABELS ARE CONTENT (#4976 ruling, 2026-09-03): `startLabel`/`endLabel` default to
// "Start"/"End" for the activity/practice pair, and the measurements mount overrides
// them to "Bed time"/"Wake time" — so `e2e/manual-vitals.spec.ts`'s existing
// `getByLabel` locators keep resolving without a second touch.
//
// OVERNIGHT (#4976 item 2): a bed-to-wake pair crosses midnight by design, so an End
// "before" Start there means the next day, not a refusal — the same rollover
// `activityWindow` applies to a dated window (`lib/training-zones.ts:225`), read here
// as the same-day-relative span `overnightMinutesBetween` computes. `overnight` mode
// OWNS the refusal decision itself (there is no "before start" to ask the host about
// any more) and ignores the incoming `timeError` for that purpose; the default mode is
// unchanged — `timeError` still is, and still means, exactly what it always has.
export default function TimeRangeFields({
  idPrefix,
  startTime,
  endTime,
  tz,
  timeError,
  derivableDurationMin,
  startName,
  endName,
  startLabel = "Start",
  endLabel = "End",
  overnight = false,
  onStartTime,
  onEndTime,
}: {
  /** Names the inputs `{idPrefix}-start-time` / `{idPrefix}-end-time`, which is what
   *  each visible label points at. Host-supplied because two mounts can share a page. */
  idPrefix: string;
  startTime: string;
  endTime: string;
  tz: string;
  /** End before Start — drawn here, refused by the host's submit. Ignored when
   *  `overnight` is true: crossing midnight is what that mode is for. */
  timeError: boolean;
  /** What the ± shortcuts are worth, or null when no duration is stated (#336). */
  derivableDurationMin: number | null;
  /** Set where the host posts the pair through FormData rather than from its state. */
  startName?: string;
  endName?: string;
  /** Content, not styling (#4976 ruling) — default "Start"/"End". */
  startLabel?: string;
  endLabel?: string;
  /** An End at or before Start means the next day rather than a refusal, and the
   *  pair's own span is reported once both clocks are set. Off by default. */
  overnight?: boolean;
  onStartTime: (v: string) => void;
  onEndTime: (v: string) => void;
}) {
  // In overnight mode the pair decides its own validity — there is no "before start"
  // to refuse — so the host's `timeError` is read only outside it.
  const overnightSpan = overnight
    ? overnightMinutesBetween(startTime, endTime)
    : null;
  const refused = overnight
    ? !!startTime && !!endTime && overnightSpan == null
    : timeError;
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
              {startLabel}
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
            label={startLabel}
            inputClassName="mt-1"
          />
        </div>
        <div>
          <div className="flex items-baseline gap-2">
            <label className="label mb-0" htmlFor={`${idPrefix}-end-time`}>
              {endLabel}
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
            label={endLabel}
            inputClassName={`mt-1 ${refused ? "border-rose-300 dark:border-rose-800" : ""}`}
          />
        </div>
      </div>
      {overnight && overnightSpan != null && (
        <p
          data-testid="time-range-span"
          className="mt-1 text-xs text-slate-500 dark:text-slate-400"
        >
          {formatSpan(overnightSpan)}
        </p>
      )}
      {refused && (
        <p className="mt-1 text-xs text-rose-500 dark:text-rose-400">
          {overnight
            ? "Bed and wake can’t be the same time."
            : "End time must be after the start time."}
        </p>
      )}
    </div>
  );
}

/** "7h 50m" / "7h" / "50m" — never both zero, since a zero-length span reads as
 *  `null` upstream and never reaches here. */
function formatSpan(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
