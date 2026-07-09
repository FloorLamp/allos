import Link from "next/link";
import { WeeklyTargets } from "@/components/WeeklyTargets";
import { frequencyScopeLabel } from "@/lib/goals";
import type { FrequencyTargetProgress } from "@/lib/queries";
import WidgetHeader from "./WidgetHeader";

// Weekly-routine card (thin wrapper around WeeklyTargets; markup preserved).
export default function WeeklyRoutineWidget({
  freqTargets,
}: {
  freqTargets: FrequencyTargetProgress[];
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Weekly routine"
        href="/training"
        linkLabel="Manage"
      />
      {freqTargets.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No weekly routine set —{" "}
          <Link
            href="/training"
            className="text-brand-600 hover:underline dark:text-brand-400"
          >
            set some on the Training page
          </Link>
          .
        </p>
      ) : (
        <WeeklyTargets
          targets={freqTargets.map((t) => ({
            id: t.target.id,
            label: frequencyScopeLabel(
              t.target.scope_kind,
              t.target.scope_value
            ),
            count: t.count,
            perWeek: t.per_week,
            met: t.met,
          }))}
        />
      )}
    </div>
  );
}
