"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconMoodCheck, IconRestore } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import EndEpisodeReconcile from "@/components/illness/EndEpisodeReconcile";
import { useToast } from "@/components/Toast";
import type { EpisodeMedSuggestion } from "@/lib/episode-med-reconcile";
import { reopenEpisodeAction } from "@/app/(app)/medical/episodes/actions";

// The episode's lifecycle transition closes the timeline card after logging, History,
// and progress photos. It is deliberately separate from the timeline header's
// print/share utilities and reads as the final step rather than interrupting the record.
export default function EpisodeLifecycleControl({
  episodeId,
  ongoing,
  canReopen,
  profileId,
  medReconciliation,
}: {
  episodeId: number;
  ongoing: boolean;
  canReopen: boolean;
  profileId?: number;
  medReconciliation: EpisodeMedSuggestion[];
}) {
  const [reopening, setReopening] = useState(false);
  const confirm = useConfirm();
  const router = useRouter();
  const toast = useToast();

  if (!ongoing && !canReopen) return null;

  function stateFormData() {
    const fd = new FormData();
    fd.set("episodeId", String(episodeId));
    if (profileId != null) fd.set("profileId", String(profileId));
    return fd;
  }

  async function onReopen() {
    const ok = await confirm({
      title: "Reopen this episode?",
      message:
        "The illness will be active again, and new symptoms, temperatures, and doses will stay on this timeline.",
      confirmLabel: "Reopen episode",
    });
    if (!ok) return;
    setReopening(true);
    try {
      const result = await reopenEpisodeAction(stateFormData());
      if (!result.ok) toast(result.error);
      else router.refresh();
    } finally {
      setReopening(false);
    }
  }

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
        <button
          type="button"
          className="btn-ghost"
          data-testid="episode-reopen-action"
          onClick={() => void onReopen()}
          disabled={reopening}
        >
          <IconRestore className="h-4 w-4" stroke={1.75} />
          {reopening ? "Reopening…" : "Reopen episode"}
        </button>
      )}
    </div>
  );
}
