"use client";

import { IconMoodCheck } from "@tabler/icons-react";
import EndEpisodeReconcile from "@/components/illness/EndEpisodeReconcile";
import ReopenEpisodeReconcile, {
  type ReopenRestoreMed,
} from "@/components/illness/ReopenEpisodeReconcile";
import type { EpisodeMedSuggestion } from "@/lib/episode-med-reconcile";

// The episode's lifecycle transition closes the timeline card after logging, History,
// and progress photos. It is deliberately separate from the timeline header's
// print/share utilities and reads as the final step rather than interrupting the record.
export default function EpisodeLifecycleControl({
  episodeId,
  ongoing,
  canReopen,
  profileId,
  medReconciliation,
  reopenRestoreMeds = [],
}: {
  episodeId: number;
  ongoing: boolean;
  canReopen: boolean;
  profileId?: number;
  medReconciliation: EpisodeMedSuggestion[];
  // The meds this episode's end stopped that are still restart-eligible (#1140 Part B) —
  // the reopen checklist's suggest-only set. Empty ⇒ reopen uses the plain confirm.
  reopenRestoreMeds?: ReopenRestoreMed[];
}) {
  if (!ongoing && !canReopen) return null;

  return (
    <div
      className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-black/5 pt-5 dark:border-white/5"
      data-testid="episode-lifecycle-control"
    >
      <div className="min-w-0 max-w-xl">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {ongoing ? "Feeling better?" : "Symptoms returned?"}
        </h3>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {ongoing
            ? "End this episode when you’re ready. You can reopen it for 7 days if symptoms return."
            : "Reopen this episode to keep tracking on the same timeline."}
        </p>
      </div>

      {ongoing ? (
        <EndEpisodeReconcile
          episodeId={episodeId}
          profileId={profileId}
          meds={medReconciliation}
          triggerLabel="End episode"
          triggerTestId="episode-end"
          triggerClassName="btn-ghost"
          icon={<IconMoodCheck className="h-4 w-4" stroke={1.75} />}
        />
      ) : (
        <ReopenEpisodeReconcile
          episodeId={episodeId}
          profileId={profileId}
          meds={reopenRestoreMeds}
        />
      )}
    </div>
  );
}
