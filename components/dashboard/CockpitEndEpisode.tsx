import { IconMoodCheck } from "@tabler/icons-react";
import EndEpisodeReconcile from "@/components/illness/EndEpisodeReconcile";
import type { EpisodeMedSuggestion } from "@/lib/episode-med-reconcile";

// "Feeling better" — end an illness episode from its Now cockpit (issue #858). Now a thin
// wrapper over the shared EndEpisodeReconcile (issue #880), so the cockpit and the episode
// page end offer the SAME episode-end medication checklist (one component, no drift).
// Carries the episode id AND, for a household member's cockpit, the target profileId so the
// action gates on THAT profile (requireProfileWriteAccess) and closes their episode without
// switching. `meds` is the episode-associated med checklist (empty → ends directly).
export default function CockpitEndEpisode({
  episodeId,
  profileId,
  meds = [],
}: {
  episodeId: number;
  profileId?: number;
  meds?: EpisodeMedSuggestion[];
}) {
  return (
    <EndEpisodeReconcile
      episodeId={episodeId}
      profileId={profileId}
      meds={meds}
      triggerLabel="Feeling better"
      triggerTestId="cockpit-end-episode"
      icon={<IconMoodCheck className="h-3.5 w-3.5" stroke={1.75} />}
    />
  );
}
