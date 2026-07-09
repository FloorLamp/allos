import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getInsights } from "@/lib/queries";
import { ALL_ROWS, filterSeriesByRange } from "@/lib/trends";
import { formatLongDate } from "@/lib/format-date";
import type { DateRange } from "@/lib/timeline-format";
import { EmptyState } from "@/components/ui";
import DateField from "@/components/DateField";
import SubmitButton from "@/components/SubmitButton";
import { generateForDate } from "./actions";

// The Trends hub's Insights section: the AI daily insights (reusing getInsights),
// windowed to the shared range, plus the generate form that used to live on the
// standalone /insights page (folded in here — sidebar consolidation). Hidden by
// the hub for age-restricted profiles (AI Insights is an age-gated surface), so
// the generate form is only ever rendered for eligible profiles.
export default function InsightsSection({ range }: { range: DateRange }) {
  const { profile } = requireSession();
  // Read every insight (ALL_ROWS overrides the default 30-row cap) so an older
  // window isn't silently truncated before filterSeriesByRange windows it.
  const insights = filterSeriesByRange(
    getInsights(profile.id, ALL_ROWS),
    range
  );

  return (
    <div className="space-y-4">
      <form
        action={generateForDate}
        className="card flex flex-wrap items-end gap-4"
      >
        <div>
          <label className="label" htmlFor="insight-date">
            Date to analyze
          </label>
          <DateField
            id="insight-date"
            name="date"
            defaultValue={today(profile.id)}
          />
        </div>
        <SubmitButton pendingLabel="Generating…">
          ✦ Generate analysis
        </SubmitButton>
        <p className="text-xs text-slate-400 dark:text-slate-500">
          AI-generated daily analysis of your activity, metrics, and goals. Uses
          Claude when <code>ANTHROPIC_API_KEY</code> is set; otherwise a
          built-in summary is generated.
        </p>
      </form>

      {insights.length === 0 ? (
        <EmptyState message="No insights in this range. Generate one above, or widen the date range." />
      ) : (
        <div className="space-y-4">
          {insights.map((i) => (
            <div key={i.id} className="card">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                  {formatLongDate(i.date)}
                </h3>
                <span className="badge bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400">
                  {i.model ?? "n/a"}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700 dark:text-slate-200">
                {i.summary}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
