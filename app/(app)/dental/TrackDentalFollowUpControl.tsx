"use client";

import SubmitButton from "@/components/SubmitButton";
import { trackDentalFollowUp } from "./actions";
import type { DentalFollowUpSummary } from "@/lib/queries";

// Per-record follow-up affordance on the Dental list (issue #700 / #705 ask 5). When
// a record has no tracked follow-up, it offers a compact interval picker + "Track
// recheck" that creates a linked, dated care-plan follow-up (the finding→follow-up
// chain's create path). When one already exists, it shows the follow-up's state — so
// a "watch #14, recheck in 6 months" finding is visible and resolvable from where it
// lives. Offered only for watch/planned records (a completed procedure needs none).
const INTERVALS: { label: string; days: number }[] = [
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "12 months", days: 365 },
];

export default function TrackDentalFollowUpControl({
  recordId,
  offer,
  existing,
}: {
  recordId: number;
  offer: boolean;
  existing?: DentalFollowUpSummary;
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
        data-testid={`dental-followup-state-${recordId}`}
        className="whitespace-nowrap rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
      >
        Recheck: {label}
      </span>
    );
  }
  if (!offer) return null;
  return (
    <form
      action={async (fd) => {
        await trackDentalFollowUp(fd);
      }}
      data-testid={`track-dental-followup-${recordId}`}
      className="flex items-center gap-1"
    >
      <input type="hidden" name="record_id" value={recordId} />
      <select
        name="interval_days"
        aria-label="Recheck interval"
        className="input w-auto py-1 text-xs"
        defaultValue={182}
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
        Track recheck
      </SubmitButton>
    </form>
  );
}
