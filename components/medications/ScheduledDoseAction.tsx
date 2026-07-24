import DoseStatusControl from "@/components/DoseStatusControl";

// Scheduled-dose metadata and actions share one presentation on the Medications
// Today panel and the medication detail page. The amount/time describe the dose;
// the buttons describe what they do. Keeping those roles separate avoids turning
// "1 tablet · Morning" into an ambiguous action label.
export default function ScheduledDoseAction({
  doseId,
  doseLabel,
  taken,
  skipped,
  pastDue = false,
  takenTime = null,
  readOnly = false,
  compactActions = false,
  profileId,
}: {
  doseId: number;
  doseLabel: string;
  taken: boolean;
  skipped: boolean;
  pastDue?: boolean;
  takenTime?: string | null;
  readOnly?: boolean;
  compactActions?: boolean;
  // #858/#1373: the dose's owning profile, for a cross-profile confirm on a
  // multi-view Medications board. Absent on the acting board (byte-identical).
  profileId?: number;
}) {
  return (
    <div
      data-testid="scheduled-dose-action"
      data-past-due={pastDue ? "1" : undefined}
      className="flex w-full flex-wrap items-center justify-between gap-2"
      title={pastDue ? "Past due — earlier today" : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {doseLabel ? (
          <span
            data-testid="scheduled-dose-detail"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            {doseLabel}
          </span>
        ) : null}
        {taken && takenTime ? (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {takenTime}
          </span>
        ) : null}
        {pastDue ? (
          <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Past due
          </span>
        ) : null}
      </div>
      {readOnly ? (
        <span
          className="text-sm font-medium text-slate-600 dark:text-slate-300"
          data-testid="scheduled-dose-readonly"
        >
          {taken
            ? `Taken${takenTime ? ` ${takenTime}` : ""}`
            : skipped
              ? "Skipped"
              : "Not logged"}
        </span>
      ) : (
        <DoseStatusControl
          doseId={doseId}
          taken={taken}
          skipped={skipped}
          variant="pill"
          label={taken ? "Taken" : "Mark taken"}
          compact={compactActions}
          profileId={profileId}
        />
      )}
    </div>
  );
}
