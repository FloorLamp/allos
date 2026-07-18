import {
  fiberIntakeSummary,
  fiberTargetSummary,
  fiberAdequacyTitle,
  type FiberAdequacy,
} from "@/lib/fiber";

// Presentational fiber-adequacy card (issue #976). A pure formatter over the ONE
// computation (getFiberAdequacy → the pure fiber engine), shared with the coaching-tier
// fiber finding so the two surfaces can't disagree. Intake band + DRI-scaled target + the
// load-bearing caveats: a non-tracked basis is a FLOOR ("actual likely higher"), an
// unknown-unit fiber supplement is noted honestly, and the whole thing is informational,
// never prescriptive. Coaching tier only — never a push. Sits beside the protein card.

const STATUS_TINT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

export default function FiberAdequacyCard({
  adequacy,
}: {
  adequacy: FiberAdequacy;
}) {
  const { intake, target, status } = adequacy;
  return (
    <div
      data-testid="fiber-adequacy"
      data-status={status}
      data-basis={intake.basis}
      className={`card border-l-4 ${STATUS_TINT[status] ?? STATUS_TINT.within}`}
    >
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Fiber
      </h2>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {fiberAdequacyTitle(adequacy)}
      </p>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500 dark:text-slate-400">Intake</dt>
          <dd
            data-testid="fiber-intake"
            className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
          >
            {fiberIntakeSummary(intake)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500 dark:text-slate-400">Target</dt>
          <dd
            data-testid="fiber-target"
            className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
          >
            {fiberTargetSummary(target)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {intake.basis !== "tracked"
          ? "A floor from your logged food-group servings plus any fiber supplements you confirmed — untracked foods add more. "
          : ""}
        Informational, not medical or dietary advice.
      </p>
    </div>
  );
}
