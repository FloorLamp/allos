"use client";

import SubmitButton from "@/components/SubmitButton";
import { trackSkinFollowUp } from "./actions";
import type { SkinLesionFollowUpSummary } from "@/lib/queries";

// Per-record follow-up affordance on the Skin list (issue #700 / #715 ask 3). When a
// lesion record has no tracked follow-up, it offers a compact interval picker + "Track
// recheck" that creates a linked, dated care-plan follow-up (the finding→follow-up
// chain's create path). When one already exists, it shows the follow-up's state — so a
// "watch this mole, recheck in 3 months" lesion is visible and resolvable from where it
// lives. Offered only for active/watch records (a removed lesion needs none). Copy is
// informational — a recheck, never a judgment about the lesion.
const INTERVALS: { label: string; days: number }[] = [
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "12 months", days: 365 },
];

export default function TrackSkinFollowUpControl({
  recordId,
  offer,
  existing,
}: {
  recordId: number;
  offer: boolean;
  existing?: SkinLesionFollowUpSummary;
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
        data-testid={`skin-followup-state-${recordId}`}
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
        await trackSkinFollowUp(fd);
      }}
      data-testid={`track-skin-followup-${recordId}`}
      className="flex items-center gap-1"
    >
      <input type="hidden" name="record_id" value={recordId} />
      <select
        name="interval_days"
        aria-label="Recheck interval"
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
        Track recheck
      </SubmitButton>
    </form>
  );
}
