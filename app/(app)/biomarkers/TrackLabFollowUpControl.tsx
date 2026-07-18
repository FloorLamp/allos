"use client";

import SubmitButton from "@/components/SubmitButton";
import { trackLabFollowUp, trackIopFollowUp } from "./actions";
import type { LabFollowUpSummary } from "@/lib/queries";

// Per-biomarker follow-up affordance on the biomarker detail page (issue #700 labs
// adapter + #698 §6 IOP adapter). When a FLAGGED reading has no tracked follow-up, it
// offers a compact interval picker + a "Track follow-up" button that creates a linked,
// dated "Recheck …" care-plan follow-up (the finding→follow-up chain's create path).
// When one already exists, it shows the follow-up's state instead — so a flagged
// result's recheck is visible and resolvable from where the biomarker lives.
//
// One component, two adapters, chosen by `kind`: a generic biomarker ("lab") tracks a
// "Recheck <name>" via trackLabFollowUp; an intraocular-pressure reading ("iop") tracks
// the bilateral "Recheck IOP / glaucoma workup" via trackIopFollowUp (#698 §6). Only the
// posted action, the button copy, and the test hooks differ. The imaging twin is
// app/(app)/imaging/TrackFollowUpControl.tsx.
const INTERVALS: { label: string; days: number }[] = [
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "12 months", days: 365 },
];

const COPY: Record<
  "lab" | "iop",
  {
    action: (fd: FormData) => Promise<unknown>;
    button: string;
    formTestId: string;
    stateTestId: string;
  }
> = {
  lab: {
    action: trackLabFollowUp,
    button: "Track follow-up",
    formTestId: "track-lab-followup",
    stateTestId: "lab-followup-state",
  },
  iop: {
    action: trackIopFollowUp,
    button: "Track glaucoma follow-up",
    formTestId: "track-iop-followup",
    stateTestId: "iop-followup-state",
  },
};

export default function TrackLabFollowUpControl({
  recordId,
  existing,
  kind = "lab",
}: {
  recordId: number;
  existing?: LabFollowUpSummary;
  kind?: "lab" | "iop";
}) {
  const copy = COPY[kind];
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
        data-testid={copy.stateTestId}
        className="whitespace-nowrap rounded bg-brand-100 px-1.5 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
      >
        Follow-up: {label}
      </span>
    );
  }
  return (
    <form
      action={async (fd) => {
        await copy.action(fd);
      }}
      data-testid={copy.formTestId}
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
        {copy.button}
      </SubmitButton>
    </form>
  );
}
