import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  assembleIllnessEpisode,
  episodeForProfileId,
} from "@/lib/illness-episode";
import { getEpisodeRow } from "@/lib/illness-episode-store";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
  getPrnMedicationsForQuickLog,
} from "@/lib/queries";
import { getTimezone, getUnitPrefs } from "@/lib/settings";
import QuickLogPrnWidget from "@/components/dashboard/QuickLogPrnWidget";
import { SYMPTOMS } from "@/lib/symptoms";
import { shiftDateStr } from "@/lib/date";
import { isRealIsoDate } from "@/lib/date";
import { getEpisodeInRangeEvents } from "@/lib/illness-episode-events";
import { episodeComparisonFor } from "@/lib/illness-episode-compare";
import EpisodeComparison from "@/components/illness/EpisodeComparison";
import EpisodeSummary from "@/components/illness/EpisodeSummary";
import EpisodeControls from "@/components/illness/EpisodeControls";
import EpisodeLogPanel from "@/components/illness/EpisodeLogPanel";
import EpisodeEditor from "@/components/illness/EpisodeEditor";
import EpisodeInRangeEvents from "@/components/illness/EpisodeInRangeEvents";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import SymptomPhotoStrip from "@/components/illness/SymptomPhotoStrip";
import { getSymptomPhotosInRange } from "@/lib/symptom-photo-write";
import { staleEpisodeNudgeFor } from "@/lib/stale-episode-data";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { formatSchoolReturnLine } from "@/lib/school-return";

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
  const { login, profile, access } = await requireSession();
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;

  const episode = episodeForProfileId(profile.id, episodeId);
  const row = getEpisodeRow(profile.id, episodeId);
  if (!episode || !row) notFound();
  const assembled = assembleIllnessEpisode(profile.id, episode);
  const promoted = assembled.conditions.some((c) => c.fromEpisode);
  const canWrite = access === "write";

  // Item 1: the SUGGEST-ONLY stale nudge, shown only when THIS episode is the current
  // open one AND it has gone quiet. Item 2: the school-return countdown, when a fever
  // has been logged in this (open) episode. Both format over the ONE gathers (#221).
  const staleNudge = canWrite ? staleEpisodeNudgeFor(profile.id) : null;
  const showStaleNudge =
    staleNudge?.episodeId === episodeId ? staleNudge : null;
  const schoolReturn = assembled.ongoing
    ? schoolReturnStatusFor(profile.id, assembled)
    : null;

  // Item 4: symptom photos attached in the episode window (rash progression). Read
  // through a dedicated gather — NOT part of assembleIllnessEpisode / the share payload
  // (the PHI default-exclude).
  const photos =
    assembled.firstDay && assembled.lastActiveDay
      ? getSymptomPhotosInRange(
          profile.id,
          assembled.firstDay,
          assembled.lastActiveDay
        )
      : [];
  const inRangeEvents = getEpisodeInRangeEvents(
    profile.id,
    assembled.firstDay,
    assembled.lastActiveDay
  );
  const comparison = assembled.ongoing
    ? episodeComparisonFor(profile.id, episodeId)
    : null;
  // Item 6: the redose window + Log button — most useful for an OPEN episode (the 9pm
  // caregiver). Reuses the dashboard PRN widget over the SAME redoseWindowStatus (one
  // computation), never a second redose engine.
  const prnMeds =
    assembled.ongoing && canWrite
      ? getPrnMedicationsForQuickLog(profile.id)
      : [];

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
        temperatureUnit={temperatureUnit}
      />
      {schoolReturn && (
        <p
          data-testid="school-return-line"
          className="mt-3 rounded-xl border border-black/10 bg-white/70 p-3 text-sm text-slate-600 dark:border-white/10 dark:bg-ink-900/50 dark:text-slate-300"
        >
          {formatSchoolReturnLine(schoolReturn, temperatureUnit)}
        </p>
      )}
      {showStaleNudge && (
        <StaleEpisodeNudge
          episodeId={showStaleNudge.episodeId}
          lastActivityDate={showStaleNudge.lastActivityDate}
          quietDays={showStaleNudge.quietDays}
        />
      )}
      {comparison && <EpisodeComparison comparison={comparison} />}
      <EpisodeInRangeEvents events={inRangeEvents} />
      {canWrite && (
        <EpisodeLogPanel
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          date={logDate}
          altDate={yesterday}
          initial={getSymptomSeveritiesOnDate(profile.id, logDate)}
          initialAlt={getSymptomSeveritiesOnDate(profile.id, yesterday)}
          initialNotes={getSymptomNotesOnDate(profile.id, logDate)}
          initialAltNotes={getSymptomNotesOnDate(profile.id, yesterday)}
          symptoms={SYMPTOMS}
          customNames={getCustomSymptomNames(profile.id)}
          rankedKeys={getSymptomLogOrder(profile.id)}
          temperatureUnit={temperatureUnit}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
        />
      )}
      {prnMeds.length > 0 && (
        <div className="mt-5">
          <QuickLogPrnWidget meds={prnMeds} tz={getTimezone(profile.id)} />
        </div>
      )}
      {(photos.length > 0 || canWrite) && (
        <SymptomPhotoStrip
          photos={photos.map((p) => ({
            id: p.id,
            date: p.date,
            symptom: p.symptom,
            caption: p.caption,
          }))}
          uploadDate={logDate}
          canWrite={canWrite}
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
