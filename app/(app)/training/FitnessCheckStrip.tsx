import { PendingTextLink } from "@/components/PendingLink";
import type { FitnessCheckModel } from "@/lib/fitness-check-model";

export default function FitnessCheckStrip({
  model,
}: {
  model: FitnessCheckModel;
}) {
  const retest = model.coverage.stale;
  const missing = model.coverage.unmeasured;
  const action =
    retest > 0
      ? `Retest ${retest} →`
      : missing > 0
        ? `Add ${missing} →`
        : "View →";

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
          {model.results.map((result) => {
            const state = !result.measured ? "unmeasured" : result.freshness;
            const color =
              state === "current"
                ? "bg-emerald-500"
                : state === "due"
                  ? "bg-amber-500"
                  : "bg-slate-300 dark:bg-slate-600";
            const word =
              state === "current"
                ? "current"
                : state === "due"
                  ? "retest due"
                  : "not measured";
            return (
              <span
                key={result.key}
                className={`h-2.5 w-2.5 rounded-full ${color}`}
                title={`${result.label} — ${word}`}
                aria-label={`${result.label} — ${word}`}
                data-testid="fitness-freshness-dot"
                data-state={state}
              />
            );
          })}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {model.coverage.fresh} of {model.coverage.total} current
          {retest > 0 ? ` · ${retest} due` : ""}
          {missing > 0 ? ` · ${missing} not measured` : ""}
        </p>
        <PendingTextLink
          href="/training/fitness-check"
          testId="fitness-check-strip-link"
          label="fitness check"
          className="ml-auto text-sm text-link"
        >
          {action}
        </PendingTextLink>
      </div>
    </div>
  );
}
