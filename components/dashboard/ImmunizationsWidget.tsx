import type { assessSchedule } from "@/lib/immunization-status";
import WidgetHeader from "./WidgetHeader";

type ImmSummary = ReturnType<typeof assessSchedule>;

// Immunizations snapshot (extracted from page.tsx, behavior-preserving): next-due
// / overdue against the schedule. `summary` is null when neither a birthdate nor a
// stored age is known, in which case the card nudges the user to set one.
export default function ImmunizationsWidget({
  summary,
}: {
  summary: ImmSummary | null;
}) {
  return (
    <div className="card">
      <WidgetHeader
        title="Immunizations"
        href="/immunizations"
        linkLabel="Schedule"
      />
      {!summary ? (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          Set a date of birth in Settings to see age-based vaccine
          recommendations.
        </p>
      ) : summary.nextRecommended ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <div className="text-xs text-slate-400">Next up</div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {summary.nextRecommended.name}
            </div>
          </div>
          <div className="flex gap-5 text-sm">
            <span className="text-rose-600 dark:text-rose-400">
              <strong>{summary.overdueCount}</strong> overdue
            </span>
            <span className="text-amber-600 dark:text-amber-400">
              <strong>{summary.dueCount}</strong> due
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              <strong>{summary.unknownCount}</strong> no record
            </span>
          </div>
        </div>
      ) : summary.unknownCount > 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nothing due — <strong>{summary.unknownCount}</strong> series with no
          record on file.
        </p>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Up to date on the tracked schedule.
        </p>
      )}
    </div>
  );
}
