import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import {
  BP_CATEGORY_META,
  formatBpPercentile,
  ordinal,
  type PediatricBpContext,
} from "@/lib/bp-percentiles";

// Pediatric blood-pressure context for the biomarker detail page (issue #150).
// Pure presentational: given the AAP 2017 context for one BP component (systolic
// or diastolic) of a CHILD's latest reading, it renders the percentile-for-age and
// the AAP category (Normal / Elevated / Stage 1 / Stage 2) INSTEAD OF the adult
// reference thresholds, which mis-classify children. Renders nothing when the
// context is null (adult, or sex/age unset) so the page keeps its adult behavior.
// This is the ONE surface component so the copy/category can't drift.
export function PediatricBpCard({ ctx }: { ctx: PediatricBpContext | null }) {
  if (!ctx) return null;
  const meta = BP_CATEGORY_META[ctx.category];
  return (
    <div
      data-testid="pediatric-bp-context"
      className="card mb-6 border-l-4 border-l-brand-400 dark:border-l-brand-600"
    >
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="label">Percentile for age, sex &amp; height</div>
          <div className="text-2xl font-bold text-brand-700 dark:text-brand-300">
            {formatBpPercentile(ctx)}
          </div>
        </div>
        <div>
          <div className="label">Category</div>
          <span
            className={`badge ${meta.chip}`}
            data-testid="pediatric-bp-category"
          >
            {meta.label}
          </span>
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Pediatric interpretation from {ctx.source}
        {ctx.adultRegime
          ? " — at age 13+ the AAP uses the static adolescent/adult thresholds."
          : ` — a child's blood pressure is judged by the ${ordinal(
              90
            )}/${ordinal(95)} percentile for age, sex, and height, not adult cutoffs.`}
        {ctx.heightAssumed
          ? " No tracked height, so the 50th height percentile is assumed; log a height for a precise reading."
          : ""}{" "}
        {MEDICAL_DISCLAIMER}
      </p>
    </div>
  );
}
