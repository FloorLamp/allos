import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { isRealIsoDate } from "@/lib/date";
import {
  assembleIllnessEpisode,
  episodeForProfileDate,
} from "@/lib/illness-episode";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import EpisodeControls from "@/components/illness/EpisodeControls";

export const dynamic = "force-dynamic";

// The illness-episode detail page (issue #801). Authed, active-profile scoped. The
// [date] slug is ANY day inside the episode; the containing episode is derived from it
// (never re-derived here) and assembled into the ONE model the printable/shareable
// summary formats over. Print + Share + Promote-to-condition live in EpisodeControls.
export default async function EpisodePage(props: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await props.params;
  if (!isRealIsoDate(date)) notFound();
  const { profile, access } = await requireSession();

  const episode = episodeForProfileDate(profile.id, date);
  if (!episode) notFound();
  const assembled = assembleIllnessEpisode(profile.id, episode);
  const promoted = assembled.conditions.some((c) => c.fromEpisode);
  // The anchor the actions resolve the episode from — the last active day is stable
  // and always inside the range (today for an ongoing episode).
  const anchor = assembled.lastActiveDay ?? date;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-end">
        <EpisodeControls
          anchor={anchor}
          promoted={promoted}
          canWrite={access === "write"}
        />
      </div>
      <EpisodeSummary
        episode={assembled}
        generatedAt={new Date().toISOString()}
      />
    </div>
  );
}
