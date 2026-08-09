import { IconChartBar } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";
import { recapLineAnnotation, recapRangeLabel, type Recap } from "@/lib/recap";
import { recapScaleEntry } from "@/lib/recap-scale";
import {
  DEFAULT_FORMAT_PREFS,
  type DisplayFormatPrefs,
} from "@/lib/format-date";

// The recap card (issue #32, fitness; #2178 for the scale). A quiet, factual summary
// of the last period — workouts, PRs, adherence, a robust weight trend, aerobic base,
// sleep regularity — computed rule-based (no AI) in lib/recap. Off by default; when
// the period had nothing to report it shows a gentle nudge rather than an empty card.
//
// It FOLLOWS the profile's chosen recap cadence (#2178): the heading and the empty
// state are named by the scale registry, and the card shows the IN-PROGRESS period
// while the send narrates the one that closed. One gather drives both (#221), so the
// card and the message can never disagree about a number.
//
// Every parenthetical comes from the ONE shared recapLineAnnotation (#221), so the
// card and the Telegram recap can never annotate the same line differently.
export default function WeeklyRecapWidget({
  recap,
  formatPrefs = DEFAULT_FORMAT_PREFS,
}: {
  recap: Recap;
  formatPrefs?: DisplayFormatPrefs;
}) {
  const scale = recapScaleEntry(recap.scale);
  return (
    <div className="card" data-testid="weekly-recap">
      <WidgetHeader title={scale.label} href="/timeline" />
      {recap.isEmpty || recap.lines.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing logged this {scale.noun} — log a workout or a weigh-in to
          start your recap.
        </p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
            <IconChartBar className="h-4 w-4 text-brand-500" />
            <span data-testid="weekly-recap-range">
              {recapRangeLabel(recap.start, recap.end, formatPrefs)}
            </span>
          </div>
          <dl className="space-y-2">
            {recap.lines.map((l) => {
              const annotation = recapLineAnnotation(l);
              return (
                <div
                  key={l.key}
                  className="flex items-baseline justify-between gap-3 text-sm"
                >
                  {/* A bare line is already self-labelled (#1935) — its label stays
                      for screen readers so the description list keeps its pairs,
                      but printing it would label the row twice. */}
                  <dt
                    className={
                      l.bare ? "sr-only" : "text-slate-500 dark:text-slate-400"
                    }
                  >
                    {l.label}
                  </dt>
                  <dd className={l.bare ? "min-w-0" : "min-w-0 text-right"}>
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {l.value}
                    </span>
                    {annotation && (
                      <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                        {annotation}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </div>
  );
}
