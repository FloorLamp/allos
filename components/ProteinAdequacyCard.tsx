import {
  proteinIntakeSummary,
  proteinTargetSummary,
  proteinAdequacyTitle,
  type ProteinAdequacy,
  type ProteinToday,
} from "@/lib/protein";
import ProteinGauge from "./ProteinGauge";

// Presentational protein card (issues #767, #824, #974). A pure formatter over the ONE
// computation (getProteinToday + getProteinAdequacy → the pure protein engine), shared
// with the coaching-tier adequacy finding so the surfaces can't disagree. The band gauge
// (#974) leads — today so far, this week's average, and the goal band in one visual — and
// the adequacy sentence copy (#767) stays beneath it: intake band + goal-scaled target +
// the load-bearing caveats (the estimate is a FLOOR, informational not prescriptive).
// Coaching tier only — never a push.

const STATUS_TINT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

export default function ProteinAdequacyCard({
  today,
  adequacy,
}: {
  // The band-gauge model (#974) — today so far + weekly average + goal band.
  today: ProteinToday | null;
  // The weekly adequacy verdict (#767) — the sentence copy + status tint.
  adequacy: ProteinAdequacy | null;
}) {
  if (!today && !adequacy) return null;
  // The border tint follows the WEEKLY verdict, never today's in-progress figure.
  const status = adequacy?.status;
  return (
    <div
      data-testid="protein-adequacy"
      data-status={status ?? ""}
      data-basis={adequacy?.intake.basis ?? today?.todayIntake?.basis ?? ""}
      className={`card border-l-4 ${STATUS_TINT[status ?? ""] ?? STATUS_TINT.within}`}
    >
      <h2 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Protein
      </h2>
      {adequacy && (
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
          {proteinAdequacyTitle(adequacy)}
        </p>
      )}
      {today && <ProteinGauge today={today} />}
      {adequacy && (
        <dl className="mt-3 space-y-1.5 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">Intake</dt>
            <dd
              data-testid="protein-intake"
              className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
            >
              {proteinIntakeSummary(adequacy.intake)}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500 dark:text-slate-400">Target</dt>
            <dd
              data-testid="protein-target"
              className="text-right font-medium tabular-nums text-slate-800 dark:text-slate-100"
            >
              {proteinTargetSummary(adequacy.target)}
            </dd>
          </div>
        </dl>
      )}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {(adequacy?.intake.basis ?? today?.todayIntake?.basis) !== "tracked"
          ? "A floor from your logged food-group servings plus any protein you logged directly — untracked foods add more. "
          : ""}
        Informational, not medical or dietary advice.
      </p>
    </div>
  );
}
