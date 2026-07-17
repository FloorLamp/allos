import { IconTrophy, IconCheck, IconAlertTriangle } from "@tabler/icons-react";
import type { Recap } from "@/lib/session-recap";
import { fmtRecapVolume } from "@/lib/session-recap";
import { fmtRpe } from "@/lib/rpe";
import { dispWeight } from "@/lib/units";
import type { WeightUnit } from "@/lib/settings";

// Shared presentational view of a session Recap (#924), rendered by BOTH the live
// "Session complete" step (in the activity form) and the finished-window dashboard
// card — one formatter over the ONE sessionRecap result, so the two surfaces can't
// drift (#221). Pure display: no state, no writes.
export default function SessionRecapView({
  recap,
  unit,
}: {
  recap: Recap;
  unit: WeightUnit;
}) {
  const summary: string[] = [];
  if (recap.durationMin != null && recap.durationMin > 0)
    summary.push(`${recap.durationMin} min`);
  if (recap.totalWorkingSets > 0)
    summary.push(
      `${recap.totalWorkingSets} working set${recap.totalWorkingSets === 1 ? "" : "s"}`
    );
  if (recap.totalVolumeKg > 0)
    summary.push(fmtRecapVolume(recap.totalVolumeKg, unit));
  if (recap.avgRpe != null) summary.push(`avg ${fmtRpe(recap.avgRpe)}`);

  const rollup =
    recap.targetRollup === "all-hit"
      ? { label: "All targets hit", tone: "emerald" as const }
      : recap.targetRollup === "some-missed"
        ? { label: "Some targets missed", tone: "amber" as const }
        : null;

  return (
    <div className="space-y-3" data-testid="session-recap">
      <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        {summary.join(" · ")}
        {rollup && (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
              rollup.tone === "emerald"
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
            }`}
            data-testid="recap-rollup"
          >
            {rollup.tone === "emerald" ? (
              <IconCheck className="h-3.5 w-3.5" />
            ) : (
              <IconAlertTriangle className="h-3.5 w-3.5" />
            )}
            {rollup.label}
          </span>
        )}
      </div>

      {recap.exercises.length > 0 && (
        <ul className="divide-y divide-black/5 dark:divide-white/5">
          {recap.exercises.map((ex) => (
            <li
              key={ex.exercise}
              className="flex items-center justify-between gap-3 py-1.5 text-sm"
              data-testid="recap-exercise"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-medium text-slate-800 dark:text-slate-100">
                  {ex.exercise}
                </span>
                {(ex.e1rmPR || ex.weightPR) && (
                  <span
                    className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                    title="Personal record this session"
                    data-testid="recap-pr"
                  >
                    <IconTrophy className="h-3 w-3" />
                    PR
                  </span>
                )}
                {ex.verdict === "missed" && (
                  <IconAlertTriangle
                    className="h-3.5 w-3.5 text-amber-500"
                    title="At least one set fell short of its target"
                  />
                )}
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400">
                {ex.workingSets} × ·{" "}
                {ex.volumeKg > 0
                  ? fmtRecapVolume(ex.volumeKg, unit)
                  : "bodyweight"}
                {ex.deltaE1rmKg != null && ex.deltaE1rmKg !== 0 && (
                  <span
                    className={
                      ex.deltaE1rmKg > 0
                        ? "ml-1 text-emerald-600 dark:text-emerald-400"
                        : "ml-1 text-slate-400"
                    }
                  >
                    {ex.deltaE1rmKg > 0 ? "+" : "−"}
                    {dispWeight(Math.abs(ex.deltaE1rmKg), unit, 1)} {unit} e1RM
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
