"use client";

import SubmitButton from "@/components/SubmitButton";
import { trackLabFollowUp } from "./actions";
import type { LabFollowUpSummary } from "@/lib/queries";

// Per-biomarker follow-up affordance on the biomarker detail page (issue #700 labs
// adapter). When a FLAGGED reading has no tracked follow-up for its #482 family, it
// offers a compact interval picker + "Track follow-up" that creates a linked, dated
// "Recheck …" care-plan follow-up (the finding→follow-up chain's create path). When
// one already exists, it shows the follow-up's state instead — so a flagged result's
// recheck is visible and resolvable from where the biomarker lives. The imaging twin
// is app/(app)/imaging/TrackFollowUpControl.tsx.
const INTERVALS: { label: string; days: number }[] = [
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "12 months", days: 365 },
];

export default function TrackLabFollowUpControl({
  recordId,
  existing,
}: {
  recordId: number;
  existing?: LabFollowUpSummary;
}) {
  if (existing) {
    const label = existing.resolution
      ? `resolved · ${existing.resolution}`
      : existing.status === "completed"
        ? "done"
        : existing.plannedDate
          ? `recheck due ${existing.plannedDate}`
          : "tracked";
    return (
      <span
        data-testid="lab-followup-state"
        className="whitespace-nowrap rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
      >
        Follow-up: {label}
      </span>
    );
  }
  return (
    <form
      action={async (fd) => {
        await trackLabFollowUp(fd);
      }}
      data-testid="track-lab-followup"
      className="flex items-center gap-1"
    >
      <input type="hidden" name="record_id" value={recordId} />
      <select
        name="interval_days"
        aria-label="Follow-up interval"
        className="input w-auto py-1 text-xs"
        defaultValue={91}
      >
        {INTERVALS.map((i) => (
          <option key={i.days} value={i.days}>
            {i.label}
          </option>
        ))}
      </select>
      <SubmitButton
        pendingLabel="…"
        className="whitespace-nowrap rounded-lg border border-black/10 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-750"
      >
        Track follow-up
      </SubmitButton>
    </form>
  );
}
