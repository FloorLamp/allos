import type { ReactNode } from "react";
import {
  proteinIntakeSummary,
  proteinTargetSummary,
  proteinAdequacyTitle,
  type ProteinAdequacy,
  type ProteinToday,
} from "@/lib/protein";
import ProteinGauge from "./ProteinGauge";

// The protein ROW of the "Today's nutrients" card (issues #767, #824, #974, #980). A pure
// formatter over the ONE computation (getProteinToday + getProteinAdequacy → the pure
// protein engine), shared with the coaching-tier adequacy finding so the surfaces can't
// disagree — the FINDING copy is untouched, this is one more formatter (#980 item 1). The
// band gauge (#974) leads; the #824 quick-add moves INSIDE the row (`quickAdd`), so the
// write control lives where its effect renders — tap "+30 g" and the today bar grows just
// above it. The adequacy sentence (#767) demotes to a muted caption under the gauge. A
// left status accent (never a full card border now — it's a row) carries the weekly
// verdict. Coaching tier only — never a push.

const STATUS_ACCENT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

export default function ProteinAdequacyCard({
  today,
  adequacy,
  quickAdd,
}: {
  // The band-gauge model (#974) — today so far + weekly average + goal band.
  today: ProteinToday | null;
  // The weekly adequacy verdict (#767) — the caption copy + status accent.
  adequacy: ProteinAdequacy | null;
  // The #824 grams quick-add, rendered inside the row so its effect (the today bar
  // growing) is right above the control. A ReactNode so this presentational row stays a
  // server component while the quick-add is a client island.
  quickAdd?: ReactNode;
}) {
  if (!today && !adequacy) return null;
  // The accent follows the WEEKLY verdict, never today's in-progress figure.
  const status = adequacy?.status;
  return (
    <div
      data-testid="protein-adequacy"
      data-status={status ?? ""}
      data-basis={adequacy?.intake.basis ?? today?.todayIntake?.basis ?? ""}
      className={`border-l-4 pl-3 ${STATUS_ACCENT[status ?? ""] ?? STATUS_ACCENT.within}`}
    >
      <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Protein
      </h3>
      {today && <ProteinGauge today={today} />}
      {adequacy && (
        <p
          data-testid="protein-adequacy-caption"
          className="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
          {proteinAdequacyTitle(adequacy)}
        </p>
      )}
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
      {quickAdd && <div className="mt-3">{quickAdd}</div>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        {(adequacy?.intake.basis ?? today?.todayIntake?.basis) !== "tracked"
          ? "A floor from your logged food-group servings plus any protein you logged directly — untracked foods add more. "
          : ""}
        Informational, not medical or dietary advice.
      </p>
    </div>
  );
}
