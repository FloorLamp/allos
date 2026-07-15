import {
  proteinIntakeSummary,
  proteinTargetSummary,
  proteinAdequacyTitle,
  type ProteinAdequacy,
} from "@/lib/protein";

// Presentational protein-adequacy card (issue #767). A pure formatter over the ONE
// computation (getProteinAdequacy → the pure protein engine), shared with the coaching-
// tier adequacy finding so the two surfaces can't disagree. Intake band + goal-scaled
// target + the load-bearing caveats: the estimate is a FLOOR ("actual likely higher") and
// the whole thing is informational, never prescriptive. Coaching tier only — never a push.

const STATUS_TINT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

export default function ProteinAdequacyCard({
  adequacy,
}: {
  adequacy: ProteinAdequacy;
}) {
  const { intake, target, status } = adequacy;
  return (
    <div
      data-testid="protein-adequacy"
      data-status={status}
      data-basis={intake.basis}
      className={`card border-l-4 ${STATUS_TINT[status] ?? STATUS_TINT.within}`}
    >
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Protein
      </h2>
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
        {proteinAdequacyTitle(adequacy)}
      </p>
      <dl className="mt-3 space-y-1.5 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500 dark:text-slate-400">Intake</dt>
          <dd
            data-testid="protein-intake"
            className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
          >
            {proteinIntakeSummary(intake)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-slate-500 dark:text-slate-400">Target</dt>
          <dd
            data-testid="protein-target"
            className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
          >
            {proteinTargetSummary(target)}
          </dd>
        </div>
      </dl>
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {intake.basis === "estimated"
          ? "Estimated from your logged food-group servings — a floor, since untracked foods add more. "
          : ""}
        Informational, not medical or dietary advice.
      </p>
    </div>
  );
}
