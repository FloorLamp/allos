import { IconMoon } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import {
  baselineDeltaPhrase,
  formatHm,
  type LastNightSummary,
} from "@/lib/sleep-summary";

// Dashboard "last night" sleep tile (issue #1066): the morning-ritual promotion
// that ships WITH the /sleep page (the illness-hero / weight-quick-add principle —
// the surface served by promotion, not nav position). Reads the SAME
// lastNightSummary model the page hero reads, so the tile and the hero can never
// disagree ("one question, one computation", #221). SRI is passed alongside as the
// second at-a-glance figure. Compact formatter — the expanded view is /sleep.
export default function SleepLastNightWidget({
  summary,
  sri,
}: {
  summary: LastNightSummary;
  sri: number | null;
}) {
  const delta = baselineDeltaPhrase(summary);
  return (
    <div className="card" data-testid="sleep-last-night-widget">
      <WidgetHeader title="Last night" href="/sleep" />
      <div className="flex items-start gap-3">
        <IconMoon
          className="mt-1 h-5 w-5 shrink-0 text-brand-600 dark:text-brand-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
              data-testid="sleep-last-night-duration"
            >
              {formatHm(summary.durationMin)}
            </span>
            {delta && (
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {delta}
              </span>
            )}
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-300">
            {summary.bedLocal} → {summary.wakeLocal}
            {summary.napMin > 0 && (
              <span className="text-slate-500 dark:text-slate-400">
                {" "}
                · + {formatHm(summary.napMin)} nap
              </span>
            )}
          </div>
          {sri != null && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Regularity SRI {Math.round(sri)} / 100
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
