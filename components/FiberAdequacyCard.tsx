import { MEDICAL_DISCLAIMER } from "@/lib/disclaimers";
import {
  fiberIntakeSummary,
  fiberTargetSummary,
  fiberAdequacyTitle,
  type FiberAdequacy,
} from "@/lib/fiber";
import FiberGauge from "./FiberGauge";

// The fiber ROW of the "Today's nutrients" card (issues #976, #980 item 2). A pure
// formatter over the ONE computation (getFiberAdequacy → the pure fiber engine), shared
// with the coaching-tier fiber finding so the two surfaces can't disagree. The band gauge
// (#980) leads, sharing the protein row's scale/legend treatment; the adequacy sentence
// demotes to a muted caption beneath it, and the intake/target lines carry the
// load-bearing caveats: a non-tracked basis is a FLOOR ("actual likely higher"), an
// unknown-unit fiber supplement is noted honestly, and the whole thing is informational,
// never prescriptive. A left status accent (a row, not a card) carries the verdict.

const STATUS_ACCENT: Record<string, string> = {
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
      className={`border-l-4 pl-3 ${STATUS_ACCENT[status] ?? STATUS_ACCENT.within}`}
    >
      <h3 className="mb-1 font-semibold text-slate-800 dark:text-slate-100">
        Fiber
      </h3>
      <FiberGauge adequacy={adequacy} />
      <p
        data-testid="fiber-adequacy-caption"
        className="mt-2 text-xs text-slate-500 dark:text-slate-400"
      >
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
        {MEDICAL_DISCLAIMER}
      </p>
    </div>
  );
}
