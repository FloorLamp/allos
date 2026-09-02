import { chartAdherenceState } from "@/lib/chart-colors";
import type {
  AdherenceCalendarModel,
  AdherenceCalendarCell,
  AdherenceCalendarState,
} from "@/lib/adherence-calendar";
import VisualizationDetails from "@/components/VisualizationDetails";
import { StateLegend, stateCellClass } from "@/components/StateCells";

// The month adherence calendar on a medication's detail page (issue #852 item 5): the
// 14-day strip's own vocabulary (taken / partial / skipped / missed / not-due) at month
// scale, so "how's adherence actually going" has the picture the strip can't give. A
// pure/server component over the buildAdherenceCalendar grid (no new model).

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

// Cell colors come from the ONE blessed adherence palette (issue #1445), whose
// steps are validated in CI: `taken`/`partial` are two steps of the same brand
// ramp, `skipped` the neutral, `missed` the rose. Each cell also carries a
// `data-state`, and the legend and shared detail disclosure keep state from being
// color-alone.
const STATE_STYLE: Record<AdherenceCalendarState, string> = {
  taken: chartAdherenceState.taken.class,
  partial: chartAdherenceState.partial.class,
  skipped: chartAdherenceState.skipped.class,
  missed: chartAdherenceState.missed.class,
  excused: chartAdherenceState.excused.class,
  pending: chartAdherenceState.pending.class,
  na: chartAdherenceState.na.class,
};

const STATE_LABEL: Record<AdherenceCalendarState, string> = {
  taken: "Taken",
  partial: "Partial",
  skipped: "Skipped",
  missed: "Missed",
  // A slot a timezone switch jumped over (#3263) — the day the person flew east
  // never contained this hour, so the dose was impossible rather than missed. Named
  // rather than folded into "Not due": the reader is owed the reason their day is
  // short, and this is the one absence that would otherwise read as a lapse.
  excused: "Excused (travel)",
  // Today, not yet taken and not yet late enough to call anything (#2796). "Missed"
  // here contradicted the "Mark taken" button sitting a few hundred pixels away.
  pending: "Today, not yet taken",
  na: "Not due",
};

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function Cell({ cell }: { cell: AdherenceCalendarCell }) {
  if (cell.date == null || cell.state == null) {
    return <div aria-hidden="true" className="aspect-square" />;
  }
  return (
    <div
      data-testid="adherence-cal-day"
      data-state={cell.state}
      className={stateCellClass("tile", STATE_STYLE[cell.state])}
    >
      {dayNumber(cell.date)}
    </div>
  );
}

export default function AdherenceCalendar({
  model,
}: {
  model: AdherenceCalendarModel;
}) {
  if (model.weeks.length === 0) return null;
  const legend: AdherenceCalendarState[] = [
    "taken",
    "partial",
    "skipped",
    "missed",
    "excused",
    "pending",
    "na",
  ];
  return (
    <div
      className="flex w-full flex-col gap-3 lg:flex-row lg:items-start lg:gap-6"
      data-testid="adherence-calendar"
    >
      <div
        className="w-full max-w-64 shrink-0"
        data-testid="adherence-calendar-grid"
      >
        <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-medium uppercase text-slate-500 dark:text-slate-400">
          {WEEKDAYS.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </div>
        <div
          className="grid grid-cols-7 gap-1"
          data-testid="adherence-calendar-days"
        >
          {model.weeks.flatMap((week, wi) =>
            week.map((cell, ci) => <Cell key={`${wi}-${ci}`} cell={cell} />)
          )}
        </div>
        <VisualizationDetails
          label="Daily details"
          items={model.weeks.flatMap((week) =>
            week.flatMap((cell) =>
              cell.date && cell.state
                ? [`${cell.date} · ${STATE_LABEL[cell.state]}`]
                : []
            )
          )}
        />
      </div>
      <StateLegend
        label="Adherence legend"
        testId="adherence-calendar-legend"
        className="lg:mt-5 lg:w-32 lg:flex-none lg:flex-col lg:border-l lg:border-black/5 lg:pl-3 dark:lg:border-white/5"
        items={legend.map((s) => ({
          key: s,
          // `na` paints nothing, so in a key — away from the grid that gives it
          // context — it needs an outline or there is no swatch to read.
          tone:
            s === "na"
              ? `${STATE_STYLE[s]} border border-black/15 dark:border-white/15`
              : STATE_STYLE[s],
          label: STATE_LABEL[s],
          count: model.counts[s],
        }))}
      />
    </div>
  );
}
