"use client";

import DoseStatusControl from "@/components/DoseStatusControl";
import { useTimeStatement } from "@/components/TimeStatement";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";

// Scheduled-dose metadata and actions share one presentation on the Medications
// Today panel and the medication detail page. The amount/time describe the dose;
// the buttons describe what they do. Keeping those roles separate avoids turning
// "1 tablet · Morning" into an ambiguous action label. The editable row also owns
// the pill control's coarse-pointer reserve: padding contains the full 44px box,
// while a matching vertical negative margin preserves its 32px visual alignment in
// surrounding rows. Fine-pointer desktop returns to the original compact geometry.
//
// AND THIS IS WHERE A SCHEDULED DOSE TELLS ITS TIME (#4426). Every other one-tap
// domain could say "this happened earlier than my tap"; the doses — the times with the
// most clinical weight — could not, on any web surface. A confirm at 09:00 of a dose
// actually taken at 07:00 had to go through the full backfill form, or through a
// Telegram correction chip whose restamp has no web caller. The statement is offered
// only on an UNRESOLVED dose: once a row is taken or skipped, changing what the record
// says was given is the dose-history panel's audited door, not this tap's.
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
  // The row stands on the profile's today — the day `setDoseStatus` files an undated
  // confirm under. The STATEMENT is a wall time and the action anchors it on that same
  // day in the OWNING profile's zone, so the pair cannot come apart; this day only
  // decides what the control renders and offers.
  const statement = useTimeStatement({
    shown: !readOnly && !taken && !skipped,
    day: dateStrInTz(useTimezone()),
    label: "Taken earlier?",
    timeLabel: `Time ${doseLabel || "this dose"} was taken`,
    testId: "scheduled-dose-when",
    className: "w-full",
  });
  return (
    <div
      data-testid="scheduled-dose-action"
      data-past-due={pastDue ? "1" : undefined}
      className={`flex w-full flex-wrap items-center justify-between gap-2${
        readOnly
          ? ""
          : " -my-1.5 p-1.5 sm:pointer-fine:my-0 sm:pointer-fine:p-0"
      }`}
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
          // #3970 rule 1: "Past due — earlier today" was a constant explainer
          // mounted once per scheduled dose, and its two extra words add nothing the
          // visible label lacks — the row already sits under today's date.
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
          statement={statement}
        />
      )}
      {statement.node}
    </div>
  );
}
