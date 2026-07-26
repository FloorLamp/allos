import type { ProteinAdequacy, ProteinToday } from "@/lib/protein";
import ProteinGauge from "./ProteinGauge";

// The protein ROW of the "Today's nutrients" card (issues #767, #824, #974, #980). A pure
// formatter over the ONE computation (getProteinToday + getProteinAdequacy → the pure
// protein engine), shared with the coaching-tier adequacy finding so the surfaces can't
// disagree — the FINDING copy is untouched, this is one more formatter (#980 item 1). The
// band gauge (#974) leads. The gram quick-add now lives in the food logging flow, leaving
// this analysis row read-only. The adequacy sentence (#767) demotes to a muted caption
// under the gauge. A left status accent (never a full card border now — it's a row)
// carries the weekly verdict. Coaching tier only — never a push.

const STATUS_ACCENT: Record<string, string> = {
  below: "border-l-amber-300 dark:border-l-amber-700",
  within: "border-l-emerald-300 dark:border-l-emerald-700",
  above: "border-l-slate-300 dark:border-l-slate-600",
};

const STATUS_LABEL: Record<string, string> = {
  below: "Below goal",
  within: "In range",
  above: "Above goal",
};

export default function ProteinAdequacyCard({
  today,
  adequacy,
  periodLabel,
}: {
  // The band-gauge model (#974) — today so far + weekly average + goal band.
  today: ProteinToday | null;
  // The weekly adequacy verdict (#767) — the caption copy + status accent.
  adequacy: ProteinAdequacy | null;
  // "Today" by default; historical date views pass "Yesterday" / the formatted
  // weekday so the gauge never labels an older estimate as today's.
  periodLabel?: string;
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
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="font-semibold text-slate-800 dark:text-slate-100">
          Protein
        </h3>
        {status && (
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>
      {today && <ProteinGauge today={today} periodLabel={periodLabel} />}
    </div>
  );
}
