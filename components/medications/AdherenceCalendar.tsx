import type {
  AdherenceCalendarModel,
  AdherenceCalendarCell,
} from "@/lib/adherence-calendar";
import type { AdherenceState } from "@/lib/supplement-adherence";

// The month adherence calendar on a medication's detail page (issue #852 item 5): the
// 14-day strip's own vocabulary (taken / partial / skipped / missed / not-due) at month
// scale, so "how's adherence actually going" has the picture the strip can't give. A
// pure/server component over the buildAdherenceCalendar grid (no new model).

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

const STATE_STYLE: Record<AdherenceState, string> = {
  taken: "bg-emerald-500 text-white dark:bg-emerald-600",
  partial:
    "bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100",
  skipped: "bg-slate-300 text-slate-700 dark:bg-ink-700 dark:text-slate-200",
  missed: "bg-rose-400 text-white dark:bg-rose-600",
  na: "bg-transparent text-slate-500 dark:text-slate-400",
};

const STATE_LABEL: Record<AdherenceState, string> = {
  taken: "Taken",
  partial: "Partial",
  skipped: "Skipped",
  missed: "Missed",
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
      title={`${cell.date} · ${STATE_LABEL[cell.state]}`}
      className={`flex aspect-square items-center justify-center rounded text-xs font-medium ${STATE_STYLE[cell.state]}`}
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
  const legend: AdherenceState[] = [
    "taken",
    "partial",
    "skipped",
    "missed",
    "na",
  ];
  return (
    <div data-testid="adherence-calendar">
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-xs font-medium uppercase text-slate-500 dark:text-slate-400">
        {WEEKDAYS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {model.weeks.flatMap((week, wi) =>
          week.map((cell, ci) => <Cell key={`${wi}-${ci}`} cell={cell} />)
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        {legend.map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span
              className={`inline-block h-3 w-3 rounded ${STATE_STYLE[s]} ${
                s === "na" ? "border border-black/15 dark:border-white/15" : ""
              }`}
              aria-hidden="true"
            />
            {STATE_LABEL[s]} ({model.counts[s]})
          </span>
        ))}
      </div>
    </div>
  );
}
