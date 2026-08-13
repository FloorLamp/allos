import { chartActivityTypeBlock } from "@/lib/chart-colors";
import {
  WEEK_SPINE_TYPE_LABEL,
  weekSpineDaySummary,
  type WeekSpine as WeekSpineData,
} from "@/lib/training-week-spine";
import { ACTIVITY_TYPES } from "@/lib/types";

// THE WEEK SPINE (#2566, Viz 1) — Training → Overview's week, as a band.
//
// It replaces two numbers ("Sessions 4 · Days 3") with the same week laid out as its
// days, and it composes with the weekly routine rather than sitting beside it in a
// second card with a second vocabulary. Presentation only: every value here is
// computed elsewhere and passed in — the day cells by `buildWeekSpine` over the week's
// own (day, type) tallies, the caption's counts by `getTrainingLogWeekSummary` folded
// from those same rows, the routine chips by the cadence ledger.
//
// The band makes NO judgement. An empty day is empty, not red; a day after today is
// "ahead", which is not a miss. There is no plan tick, because the routine model has
// no weekday to tick against (see the module header of lib/training-week-spine.ts).

// A day's block column is capped so one heavy day cannot stretch the band; the
// overflow is stated in the cell's "+N" marker and its accessible summary, never
// silently dropped.
const MAX_BLOCKS = 4;

export default function WeekSpine({ spine }: { spine: WeekSpineData }) {
  // The caption states the SAME fold the band draws — `buildWeekSpine` returns both,
  // so the picture and the numbers cannot disagree, and `getTrainingLogWeekSummary`
  // (the Log's and History's copy of these two numbers) folds the same rows over the
  // same window.
  const { sessions, activeDays } = spine;
  // Legend entries for the types this week actually contains, in the DECLARED block
  // order (not first-seen order — the legend must read the same whichever day logged
  // what first). A type nobody logged gets no swatch: the legend explains the picture,
  // it is not a catalog of what the app can store.
  const logged = new Set(
    spine.days.flatMap((d) => d.blocks.map((b) => b.type))
  );
  const present = ACTIVITY_TYPES.filter((t) => logged.has(t));

  return (
    <div data-testid="week-spine">
      <div
        className="mt-3 grid grid-cols-7 gap-1.5"
        role="list"
        aria-label="This week's training days"
      >
        {spine.days.map((day) => {
          const summary = weekSpineDaySummary(day);
          // One square per SESSION, in the declared type order, capped as a whole —
          // the cap is on squares, not on type groups, so a single eight-session day
          // cannot stretch the band either.
          const squares = day.blocks.flatMap((b) =>
            Array.from({ length: b.count }, () => b.type)
          );
          const shown = squares.slice(0, MAX_BLOCKS);
          const overflow = squares.length - shown.length;
          return (
            <div
              key={day.date}
              role="listitem"
              data-testid="week-spine-day"
              data-date={day.date}
              data-state={day.state}
              data-sessions={day.sessions}
              title={summary}
              aria-label={summary}
              className="flex flex-col items-center gap-1"
            >
              <span
                className={`text-xs font-medium uppercase ${
                  day.state === "today"
                    ? "text-brand-700 dark:text-brand-400"
                    : "text-slate-500 dark:text-slate-400"
                }`}
              >
                {day.weekdayLabel}
              </span>
              <div
                className={`flex h-16 w-full flex-col-reverse justify-start gap-0.5 rounded-md p-0.5 ${
                  day.state === "ahead"
                    ? "bg-slate-50 dark:bg-ink-900"
                    : "bg-slate-100 dark:bg-ink-800"
                } ${
                  day.state === "today"
                    ? "ring-2 ring-brand-500 dark:ring-brand-400"
                    : ""
                }`}
              >
                {shown.map((type, i) => (
                  <span
                    key={`${type}-${i}`}
                    data-testid="week-spine-block"
                    data-type={type}
                    className={`h-3 w-full shrink-0 rounded-xs ${chartActivityTypeBlock[type].blockClass}`}
                  />
                ))}
                {overflow > 0 && (
                  <span
                    data-testid="week-spine-overflow"
                    className="text-center text-xs font-semibold text-slate-500 dark:text-slate-400"
                  >
                    +{overflow}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p
        className="mt-2 text-sm text-slate-600 dark:text-slate-300"
        data-testid="week-spine-caption"
      >
        <span className="font-semibold text-slate-900 dark:text-slate-100">
          {sessions} {sessions === 1 ? "session" : "sessions"}
        </span>{" "}
        on {activeDays} {activeDays === 1 ? "day" : "days"} this week
      </p>

      {present.length > 0 && (
        <ul
          className="mt-2 flex flex-wrap gap-x-3 gap-y-1"
          data-testid="week-spine-legend"
        >
          {present.map((type) => (
            <li
              key={type}
              data-testid="week-spine-legend-item"
              data-type={type}
              className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
            >
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 rounded-xs ${chartActivityTypeBlock[type].blockClass}`}
              />
              {WEEK_SPINE_TYPE_LABEL[type]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
