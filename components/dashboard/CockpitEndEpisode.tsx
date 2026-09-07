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
      // THE BOARD'S TREATMENT (#5487 fix 4): a solid primary, no glyph. This is the
      // action the cockpit's whole state ripens toward, and #4752 §1 approved it as
      // the header's one primary. The episode page's own end control is unchanged —
      // there it sits under a heading that already asks the question.
      triggerVariant="primary"
    />
  );
}
