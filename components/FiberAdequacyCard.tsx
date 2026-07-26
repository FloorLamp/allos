import type { FiberAdequacy } from "@/lib/fiber";
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

const STATUS_LABEL: Record<string, string> = {
  below: "Below goal",
  within: "In range",
  above: "Above range",
};

export default function FiberAdequacyCard({
  adequacy,
  periodLabel,
}: {
  adequacy: FiberAdequacy;
  // Weekly cards use the default "Avg"; historical day views name their day.
  periodLabel?: string;
}) {
  const { intake, status } = adequacy;
  return (
    <div
      data-testid="fiber-adequacy"
      data-status={status}
      data-basis={intake.basis}
      className={`border-l-4 pl-3 ${STATUS_ACCENT[status] ?? STATUS_ACCENT.within}`}
    >
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Fiber
        </h3>
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <FiberGauge adequacy={adequacy} periodLabel={periodLabel} />
    </div>
  );
}
