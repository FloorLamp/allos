import { chartAdherenceState } from "@/lib/chart-colors";
import {
  buildSupplementWeeklyAdherence,
  type SupplementAdherenceDayInput,
  type WeeklyAdherenceState,
} from "@/lib/supplement-weekly-adherence";
import { weekdayOfDateStr } from "@/lib/date";

const STATE_CLASS: Record<WeeklyAdherenceState, string> = {
  taken: chartAdherenceState.taken.class,
  partial: chartAdherenceState.partial.class,
  skipped: chartAdherenceState.skipped.class,
  missed: chartAdherenceState.missed.class,
  na: "border border-black/10 bg-transparent text-slate-500 dark:border-white/10 dark:text-slate-400",
  pending:
    "border border-dashed border-brand-300 bg-brand-50 text-brand-800 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-300",
};

const WEEKDAY_LABELS = ["Su", "M", "Tu", "W", "Th", "F", "Sa"] as const;
const LEGEND_ORDER: WeeklyAdherenceState[] = [
  "taken",
  "partial",
  "missed",
  "skipped",
  "pending",
  "na",
];
const STATE_LABEL: Record<WeeklyAdherenceState, string> = {
  taken: "Taken",
  partial: "Partial",
  missed: "Missed",
  skipped: "Skipped",
  pending: "In progress",
  na: "Not due",
};

function weekdayLabel(date: string): string {
  return WEEKDAY_LABELS[weekdayOfDateStr(date)] ?? "?";
}

function cellText(
  day: ReturnType<typeof buildSupplementWeeklyAdherence>["days"][number]
) {
  if (day.state === "na") return "·";
  if (day.state === "skipped") return "—";
  return `${day.taken}/${day.intended}`;
}

function dayDescription(
  day: ReturnType<typeof buildSupplementWeeklyAdherence>["days"][number],
  label: string
): string {
  if (day.state === "na") return `${label}: not due`;
  const skipText = day.skipped > 0 ? `, ${day.skipped} skipped` : "";
  if (day.state === "pending")
    return `${label}: ${day.taken} of ${day.intended} intended doses taken, ${day.pending} pending${skipText}`;
  return `${label}: ${day.taken} of ${day.intended} intended doses taken${skipText}`;
}

// Compact stack-level weekly view for the Supplements rail. The per-item rows
// retain their 14-day summaries; this answers the broader "how is this week going?"
// question without repeating the schedule.
export default function SupplementWeeklyAdherence({
  days,
  labels,
}: {
  days: SupplementAdherenceDayInput[];
  labels: Record<string, string>;
}) {
  const summary = buildSupplementWeeklyAdherence(days);
  if (summary.days.every((day) => day.due === 0)) return null;
  const legendStates = LEGEND_ORDER.filter((state) =>
    summary.days.some((day) => day.state === state)
  );

  return (
    <section className="p-4" data-testid="supplement-weekly-adherence">
      <h2 className="mb-2 section-label">This week</h2>
      <div className="flex items-baseline gap-2">
        <span
          data-testid="supplement-weekly-adherence-value"
          className="text-2xl font-semibold tracking-tight tabular-nums text-slate-900 dark:text-white"
        >
          {summary.pct == null ? "—" : `${summary.pct}%`}
        </span>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          adherence
        </span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
        {summary.intended > 0
          ? `${summary.taken}/${summary.intended} intended doses`
          : "No completed doses yet"}
        {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""}
      </p>

      <div
        className="mt-3 grid gap-1.5"
        style={{
          gridTemplateColumns: `repeat(${summary.days.length}, minmax(0, 2.25rem))`,
        }}
        aria-label="Daily supplement adherence this week"
        data-testid="supplement-weekly-adherence-days"
      >
        {summary.days.map((day) => {
          const fullLabel = labels[day.date] ?? day.date;
          return (
            <div key={day.date} className="min-w-0 text-center">
              <span
                data-testid="supplement-weekly-adherence-weekday"
                className="mb-1 block text-xs font-medium uppercase text-slate-500 dark:text-slate-400"
              >
                {weekdayLabel(day.date)}
              </span>
              <div
                data-testid="supplement-weekly-adherence-day"
                data-state={day.state}
                aria-label={dayDescription(day, fullLabel)}
                title={dayDescription(day, fullLabel)}
                className={`flex h-9 items-center justify-center rounded-md text-xs font-semibold tabular-nums ${STATE_CLASS[day.state]}`}
              >
                {cellText(day)}
              </div>
            </div>
          );
        })}
      </div>
      <ul
        aria-label="Adherence state legend"
        data-testid="supplement-weekly-adherence-legend"
        className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400"
      >
        {legendStates.map((state) => (
          <li key={state} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className={`h-2.5 w-2.5 rounded-xs ${STATE_CLASS[state]}`}
            />
            {STATE_LABEL[state]}
          </li>
        ))}
      </ul>
      {summary.days.some((day) => day.isToday && day.state === "pending") && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Today is still in progress.
        </p>
      )}
    </section>
  );
}
