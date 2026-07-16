import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  assembleIllnessEpisode,
  episodeForProfileId,
} from "@/lib/illness-episode";
import { getEpisodeRow } from "@/lib/illness-episode-store";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import EpisodeControls from "@/components/illness/EpisodeControls";

export const dynamic = "force-dynamic";

// The illness-episode detail page (issues #801/#856). Authed, active-profile scoped. The
// slug is now the STABLE episode ROW id (#856) — it survives boundary edits, unlike the
// old date slug (the #203 date/name-keyed-state fix). The row supplies the [start, end)
// the ONE assembly (#221) formats over; annotations (note/outcome) ride the row.
export default async function EpisodePage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  const episodeId = Number(id);
  if (!Number.isInteger(episodeId) || episodeId <= 0) notFound();
  const { profile, access } = await requireSession();

  const episode = episodeForProfileId(profile.id, episodeId);
  const row = getEpisodeRow(profile.id, episodeId);
  if (!episode || !row) notFound();
  const assembled = assembleIllnessEpisode(profile.id, episode);
  const promoted = assembled.conditions.some((c) => c.fromEpisode);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-end">
        <EpisodeControls
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          promoted={promoted}
          canWrite={access === "write"}
        />
      </div>
      <EpisodeSummary
        episode={assembled}
        note={row.note}
        outcome={row.outcome}
        generatedAt={new Date().toISOString()}
      />
    </div>
  );
}
