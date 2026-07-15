import {
  fitnessContext,
  formatPercentile,
  formatFitnessAge,
  type FitnessContext,
} from "@/lib/fitness-norms";
import type { Sex } from "@/lib/types";

// Age/sex PERCENTILE + FITNESS AGE context for the longevity fitness markers
// (VO2 Max, grip strength, 30-second chair stand, single-leg balance) — issue #158.
// Pure presentational: it computes fitnessContext() from the marker name + the
// latest value (in the marker's canonical unit) + the profile's sex/age, and renders
// nothing when the context is null (marker has no norms, or sex/age unset, or the
// subject is a child — the adult-context gate). This is the ONE surface component,
// shared by the biomarker detail page (card) and the Trends table (inline).

export function fitnessContextFor(
  name: string,
  value: number | null | undefined,
  sex: Sex | null | undefined,
  age: number | null | undefined
): FitnessContext | null {
  return fitnessContext(name, value, sex, age);
}

// The full card for the biomarker detail page.
export function FitnessPercentileCard({ ctx }: { ctx: FitnessContext | null }) {
  if (!ctx) return null;
  return (
    <div
      data-testid="fitness-percentile"
      className="card mb-6 border-l-4 border-l-brand-400 dark:border-l-brand-600"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="label">Percentile for your age</div>
          <div className="text-2xl font-bold text-brand-700 dark:text-brand-300">
            {formatPercentile(ctx.percentile)}
          </div>
        </div>
        {ctx.fitnessAge && (
          <div>
            <div className="label">Fitness age</div>
            <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
              {formatFitnessAge(ctx.fitnessAge)}
              <span className="ml-1 text-sm font-normal text-slate-500 dark:text-slate-400">
                yrs
              </span>
            </div>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Compared with same-age, same-sex population norms ({ctx.source}) —
        informational, not medical advice. Fitness age is the age whose median
        value matches your reading.
      </p>
    </div>
  );
}

// A compact inline phrase for a dense list (Trends biomarker table).
export function FitnessPercentileInline({
  ctx,
}: {
  ctx: FitnessContext | null;
}) {
  if (!ctx) return null;
  return (
    <span
      data-testid="fitness-percentile-inline"
      className="ml-2 whitespace-nowrap text-xs font-medium text-brand-600 dark:text-brand-400"
      title={`Compared with same-age, same-sex norms (${ctx.source})`}
    >
      · {formatPercentile(ctx.percentile)}
    </span>
  );
}
