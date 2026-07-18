import {
  CYCLE_PHASE_LABELS,
  FLOW_LABELS,
  type CyclePeriod,
  type CyclePhase,
} from "@/lib/cycle";

// The derived cycle phase (+ a period marker) for a day, on the Timeline day header
// (issue #714). Renders NOTHING when no phase is derivable (no cycle history covers the
// day), so callers can drop it in unconditionally — it only appears once periods are
// logged (the degrade-gracefully pattern, mirroring DaylightChip). Informational only.
//
// Server-safe: a pure formatter over the phase/period the page computes with the ONE
// cyclePhaseOnDate / periodOnDate derivations (lib/cycle.ts).
export default function CyclePhaseChip({
  phase,
  period,
}: {
  phase: CyclePhase | null;
  period: CyclePeriod | null;
}) {
  if (!phase) return null;
  const menstrual = phase === "menstrual";
  const tone = menstrual
    ? "text-rose-600 dark:text-rose-400"
    : phase === "luteal"
      ? "text-violet-600 dark:text-violet-400"
      : "text-emerald-600 dark:text-emerald-400";
  const label = menstrual ? "Period" : CYCLE_PHASE_LABELS[phase];
  const flow =
    menstrual && period?.flow ? ` · ${FLOW_LABELS[period.flow]}` : "";
  return (
    <div
      data-testid="cycle-phase-chip"
      className={`mt-1 inline-flex items-center gap-1 text-xs font-medium ${tone}`}
    >
      <span aria-hidden>{menstrual ? "🩸" : "○"}</span>
      {label}
      {flow}
    </div>
  );
}
