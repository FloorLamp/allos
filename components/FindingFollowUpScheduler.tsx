"use client";

import { SubmitActionChip } from "@/components/Button";
import { followUpStateLabel } from "@/lib/followup";

const INTERVALS = [
  [91, "3 months"],
  [182, "6 months"],
  [365, "12 months"],
] as const;

export type FindingFollowUpKind = "lab" | "iop" | "imaging" | "dental" | "skin";
const DEFAULT_INTERVAL = {
  lab: 91,
  iop: 91,
  imaging: 365,
  dental: 182,
  skin: 91,
} as const satisfies Record<FindingFollowUpKind, (typeof INTERVALS)[number][0]>;
type FollowUpState = Parameters<typeof followUpStateLabel>[0];

export default function FindingFollowUpScheduler({
  action,
  existing,
  kind,
  sourceId,
}: {
  action: (formData: FormData) => Promise<unknown>;
  existing?: FollowUpState;
  kind: FindingFollowUpKind;
  sourceId: number;
}) {
  const reading = kind === "lab" || kind === "iop";
  const recheck = kind === "dental" || kind === "skin";
  const suffix = reading ? "" : `-${sourceId}`;
  const intervalLabel = recheck ? "Recheck interval" : "Follow-up interval";
  const submitLabel = recheck
    ? "Track recheck"
    : kind === "iop"
      ? "Track glaucoma follow-up"
      : "Track follow-up";
  const formId =
    kind === "imaging" ? "track-followup" : `track-${kind}-followup`;

  if (existing) {
    const label = followUpStateLabel(existing, reading ? "recheck due" : "due");
    return (
      <span
        data-testid={`${kind}-followup-state${suffix}`}
        className="whitespace-nowrap rounded-sm bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
      >
        {recheck ? "Recheck" : "Follow-up"}: {label}
      </span>
    );
  }

  return (
    <form
      action={async (formData) => void (await action(formData))}
      aria-label={submitLabel}
      data-testid={`${formId}${suffix}`}
      className="inline-flex max-w-full items-center gap-1"
    >
      <input
        type="hidden"
        name={kind === "imaging" ? "study_id" : "record_id"}
        value={sourceId}
      />
      <select
        name="interval_days"
        aria-label={intervalLabel}
        className="input min-w-0 w-auto py-1 text-xs"
        defaultValue={DEFAULT_INTERVAL[kind]}
      >
        {INTERVALS.map(([days, label]) => (
          <option key={days} value={days}>
            {label}
          </option>
        ))}
      </select>
      <SubmitActionChip aria-label={submitLabel} pendingLabel="…">
        {submitLabel}
      </SubmitActionChip>
    </form>
  );
}
