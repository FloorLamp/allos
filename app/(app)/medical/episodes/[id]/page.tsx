import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  assembleIllnessEpisode,
  episodeForProfileId,
} from "@/lib/illness-episode";
import { getEpisodeRow } from "@/lib/illness-episode-store";
import {
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
} from "@/lib/queries";
import { SYMPTOMS } from "@/lib/symptoms";
import { shiftDateStr } from "@/lib/date";
import { isRealIsoDate } from "@/lib/date";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import EpisodeControls from "@/components/illness/EpisodeControls";
import EpisodeLogPanel from "@/components/illness/EpisodeLogPanel";
import EpisodeEditor from "@/components/illness/EpisodeEditor";

export const dynamic = "force-dynamic";

// The illness-episode detail page (issues #801/#856). Authed, active-profile scoped. The
// slug is now the STABLE episode ROW id (#856) — it survives boundary edits, unlike the
// old date slug (the #203 date/name-keyed-state fix). The row supplies the [start, end)
// the ONE assembly (#221) formats over; annotations (note/outcome) ride the row. The
// page also hosts in-place logging (item 11, the shared SymptomLogBar) and boundary/note
// editing (item 1).
export default async function EpisodePage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ logDay?: string }>;
}) {
  const { id } = await props.params;
  const { logDay } = await props.searchParams;
  const episodeId = Number(id);
  if (!Number.isInteger(episodeId) || episodeId <= 0) notFound();
  const { profile, access } = await requireSession();

  const episode = episodeForProfileId(profile.id, episodeId);
  const row = getEpisodeRow(profile.id, episodeId);
  if (!episode || !row) notFound();
  const assembled = assembleIllnessEpisode(profile.id, episode);
  const promoted = assembled.conditions.some((c) => c.fromEpisode);
  const canWrite = access === "write";

  // The logging bar anchors to today for an open episode; for a closed one it anchors to
  // the last active day, or a ?logDay= inside the range (backfill mode — item 11).
  const rangeStart = assembled.firstDay;
  const rangeEnd = assembled.lastActiveDay;
  const inRange =
    logDay && isRealIsoDate(logDay) && rangeStart && rangeEnd
      ? logDay >= rangeStart && logDay <= rangeEnd
      : false;
  const logDate = assembled.ongoing
    ? assembled.asOf
    : inRange
      ? logDay!
      : (assembled.lastActiveDay ?? assembled.asOf);
  const yesterday = shiftDateStr(logDate, -1);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-center justify-end">
        <EpisodeControls
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          promoted={promoted}
          canWrite={canWrite}
        />
      </div>
      <EpisodeSummary
        episode={assembled}
        note={row.note}
        outcome={row.outcome}
        generatedAt={new Date().toISOString()}
      />
      {canWrite && (
        <EpisodeLogPanel
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          date={logDate}
          altDate={yesterday}
          initial={getSymptomSeveritiesOnDate(profile.id, logDate)}
          initialAlt={getSymptomSeveritiesOnDate(profile.id, yesterday)}
          symptoms={SYMPTOMS}
          customNames={getCustomSymptomNames(profile.id)}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
        />
      )}
      {canWrite && (
        <EpisodeEditor
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          startedAt={row.started_at}
          endedAt={row.ended_at}
          note={row.note}
          outcome={row.outcome}
        />
      )}
    </div>
  );
}
