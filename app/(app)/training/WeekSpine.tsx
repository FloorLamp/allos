import { chartActivityTypeBlock } from "@/lib/chart-colors";
import {
  WEEK_SPINE_TYPE_LABEL,
  weekSpineDaySummary,
  type WeekSpine as WeekSpineData,
} from "@/lib/training-week-spine";
import { ACTIVITY_TYPES } from "@/lib/types";
import { SeriesPoint, SeriesSummary } from "@/components/SeriesAccess";
import { StateLegend } from "@/components/StateCells";
import DestinationLink from "@/components/DestinationLink";
import { trainingLogDayHref, trainingLogHref } from "@/lib/hrefs";

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

// One cell's geometry, shared by both of its shapes below so the linked and unlinked
// days cannot drift apart. The grid stretches every cell to the tallest, and the
// content starts at the top, so the destination cue a linked day carries underneath
// its column does not move anybody's weekday label or block box.
const CELL_CLASS = "relative flex flex-col items-center gap-1";

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
          const marks = (
            <>
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
            </>
          );
          const cell = {
            role: "listitem",
            "data-testid": "week-spine-day",
            "data-date": day.date,
            "data-state": day.state,
            "data-sessions": day.sessions,
            className: CELL_CLASS,
          } as const;
          // A DAY WITH SESSIONS IS A DOOR TO THAT DAY'S LOG (#5003). The block a
          // person points at when they mean "the workout I just did" did nothing when
          // pressed, and the ride was two surfaces away with nothing here saying so.
          //
          // The door is the DAY, not the block: a block is a per-type count
          // (lib/training-week-spine.ts) and does not know which session it is, and a
          // day door stays true when the day holds two. It is the same rule every
          // other surface stating a day already follows (#4768), through the same
          // builder — `trainingLogDayHref`, which also carries that ruling's reason
          // for landing on the day rather than on an anchor inside it.
          //
          // `DestinationLink` draws the cue, so obviousness is the primitive's and
          // not this cell's: `lib/__tests__/destination-link-primitive.test.ts`
          // refuses a hand-rolled chevron, and the cue is visible at every viewport
          // rather than waiting for a pointer (#3375/#3958).
          //
          // An empty or ahead day stays a `SeriesPoint` — no cue, because there is
          // nothing behind it, and a door onto an empty log would be a promise the
          // Log then breaks.
          return day.sessions > 0 ? (
            <DestinationLink
              key={day.date}
              {...cell}
              href={trainingLogDayHref(day.date)}
              // The mark's own summary plus where it goes. The whole week is still
              // announced once by `SeriesSummary` below, so this replaces the hover
              // readout rather than the keyboard's list.
              aria-label={`${summary} — open the day's log`}
            >
              {marks}
            </DestinationLink>
          ) : (
            <SeriesPoint key={day.date} {...cell} label={summary}>
              {marks}
            </SeriesPoint>
          );
        })}
      </div>
      <SeriesSummary
        label="Training day by day this week"
        items={spine.days.map(weekSpineDaySummary)}
      />

      {/* The sentence leads where its own data lives: the Log at its default window
          (#5003). Same primitive, same cue — a strip whose cells are doors and whose
          caption is not would be teaching two rules at once. */}
      <DestinationLink
        href={trainingLogHref({})}
        className="mt-2 flex text-sm text-slate-600 dark:text-slate-300"
        data-testid="week-spine-caption"
      >
        <span>
          <span className="font-semibold text-slate-900 dark:text-slate-100">
            {sessions} {sessions === 1 ? "session" : "sessions"}
          </span>{" "}
          on {activeDays} {activeDays === 1 ? "day" : "days"} this week
        </span>
      </DestinationLink>

      {present.length > 0 && (
        <StateLegend
          label="Activity types this week"
          testId="week-spine-legend"
          itemTestId="week-spine-legend-item"
          className="mt-2"
          items={present.map((type) => ({
            key: type,
            tone: chartActivityTypeBlock[type].blockClass,
            label: WEEK_SPINE_TYPE_LABEL[type],
          }))}
        />
      )}
    </div>
  );
}
