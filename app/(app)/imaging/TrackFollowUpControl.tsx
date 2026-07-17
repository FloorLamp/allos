"use client";

import SubmitButton from "@/components/SubmitButton";
import { trackImagingFollowUp } from "./actions";
import type { ImagingFollowUpSummary } from "@/lib/queries";

// Per-study follow-up affordance on the Imaging list (issue #700). When a study has
// no tracked follow-up, it offers a compact interval picker + "Track follow-up" that
// creates a linked, dated care-plan follow-up (the finding→follow-up chain's create
// path). When one already exists, it shows the follow-up's state instead — so an
// incidental finding's follow-up is visible and resolvable from where the study lives.
const INTERVALS: { label: string; days: number }[] = [
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "12 months", days: 365 },
];

export default function TrackFollowUpControl({
  studyId,
  existing,
}: {
  studyId: number;
  existing?: ImagingFollowUpSummary;
}) {
  if (existing) {
    const label = existing.resolution
      ? `resolved · ${existing.resolution}`
      : existing.status === "completed"
        ? "done"
        : existing.plannedDate
          ? `due ${existing.plannedDate}`
          : "tracked";
    return (
      <span
        data-testid={`imaging-followup-state-${studyId}`}
        className="whitespace-nowrap rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
      >
        Follow-up: {label}
      </span>
    );
  }
  return (
    <form
      action={async (fd) => {
        await trackImagingFollowUp(fd);
      }}
      data-testid={`track-followup-${studyId}`}
      className="flex items-center gap-1"
    >
      <input type="hidden" name="study_id" value={studyId} />
      <select
        name="interval_days"
        aria-label="Follow-up interval"
        className="input w-auto py-1 text-xs"
        defaultValue={365}
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
