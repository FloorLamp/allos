import DestinationIndicator from "@/components/DestinationIndicator";
import { PendingTextLink } from "@/components/PendingLink";
import type { FitnessCheckModel } from "@/lib/fitness-check-model";
import type { FreshnessState } from "@/lib/freshness";
import { SeriesPoint, SeriesSummary } from "@/components/SeriesAccess";

type DotState = FreshnessState | "unmeasured";
const DOT_COLOR: Record<DotState, string> = {
  current: "bg-emerald-500",
  due: "bg-amber-500",
  "not-applicable": "bg-slate-300 dark:bg-slate-600",
  unmeasured: "bg-slate-300 dark:bg-slate-600",
};
const DOT_WORD: Record<DotState, string> = {
  current: "current",
  due: "retest due",
  "not-applicable": "not measured",
  unmeasured: "not measured",
};

export default function FitnessCheckStrip({
  model,
}: {
  model: FitnessCheckModel;
}) {
  const tests = model.results.map((result) => {
    const state: DotState = !result.measured ? "unmeasured" : result.freshness;
    return { result, state, text: `${result.label} — ${DOT_WORD[state]}` };
  });
  const retest = model.coverage.stale;
  const missing = model.coverage.unmeasured;
  const action =
    retest > 0 ? `Retest ${retest}` : missing > 0 ? `Add ${missing}` : "View";

  return (
    <div className="card py-3" id="fitness" data-testid="fitness-check-strip">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Fitness check
        </h3>
        <div
          className="flex flex-wrap gap-1.5"
          aria-label={`${model.coverage.fresh} of ${model.coverage.total} tests current`}
          data-testid="fitness-freshness-dots"
        >
          {tests.map(({ result, state, text }) => (
            <SeriesPoint
              key={result.key}
              className={`relative h-2.5 w-2.5 rounded-full ${DOT_COLOR[state]}`}
              label={text}
              data-testid="fitness-freshness-dot"
              data-state={state}
            />
          ))}
        </div>
        <SeriesSummary
          label="Fitness tests"
          items={tests.map((test) => test.text)}
        />
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {model.coverage.fresh} of {model.coverage.total} current
          {retest > 0 ? ` · ${retest} due` : ""}
          {missing > 0 ? ` · ${missing} not measured` : ""}
        </p>
        <PendingTextLink
          href="/training/fitness-check"
          testId="fitness-check-strip-link"
          label="fitness check"
          className="ml-auto inline-flex items-center gap-1 text-sm text-link"
        >
          {action}
          <DestinationIndicator />
        </PendingTextLink>
      </div>
    </div>
  );
}
