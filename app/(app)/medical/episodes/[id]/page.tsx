import { notFound } from "next/navigation";
import {
  requireSession,
  getAccessibleProfiles,
  accessForProfile,
} from "@/lib/auth";
import { assembleIllnessEpisode } from "@/lib/illness-episode";
import {
  episodeRowToDerived,
  resolveEpisodeAcrossProfiles,
} from "@/lib/illness-episode-store";
import { episodeDayNumber } from "@/lib/illness-episode-format";
import EpisodeIdentityBanner from "@/components/illness/EpisodeIdentityBanner";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
  getPrnMedicationsForQuickLog,
  getEpisodeMedReconciliation,
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

// The illness-episode detail page (issues #801/#856/#879). Authed. UNLIKE the encounters
// `[id]` precedent (which hard-scopes to the active profile, so guessing another id 404s),
// this page resolves the episode across the viewer's ACCESSIBLE profiles (issue #879): a
// caregiver following the household hero's "Full episode" link into another accessible
// member's illness reads it WITHOUT switching the acting profile. The grants boundary is
// untouched — only accessible profiles are tried, so an ungranted member's guess still
// 404s (resolveEpisodeAcrossProfiles keeps every query profile-scoped).
//
// Identity rides ON the page (#531/#534): the subject's Avatar + name lead ALWAYS, since
// identity can no longer be inferred from how you arrived. Write affordances gate on write
// access FOR THAT profile (accessForProfile, the #858 cross-profile pattern): a view-only
// grant gets a clean read-only page. The slug is the STABLE episode ROW id (#856) — it
// survives boundary edits. The row supplies the [start, end) the ONE assembly (#221)
// formats over; annotations (note/outcome) ride the row.
export default async function EpisodePage(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ logDay?: string }>;
}) {
  const { id } = await props.params;
  const { logDay } = await props.searchParams;
  const episodeId = Number(id);
  if (!Number.isInteger(episodeId) || episodeId <= 0) notFound();
  const {
    login,
    profile: activeProfile,
    access: activeAccess,
  } = await requireSession();
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;

  // Resolve across the viewer's accessible set — never trust a client-provided profile
  // id; the id in the URL is the EPISODE id, and the owning profile is derived from the
  // grants-scoped set (issue #879). An episode owned by no accessible profile 404s.
  const accessible = await getAccessibleProfiles();
  const resolved = resolveEpisodeAcrossProfiles(
    accessible.map((p) => p.id),
    episodeId
  );
  if (!resolved) notFound();
  const subject = accessible.find((p) => p.id === resolved.profileId)!;
  const profileId = resolved.profileId;
  const row = resolved.row;
  const episode = episodeRowToDerived(row);

  const crossProfile = profileId !== activeProfile.id;
  // Write access FOR THE SUBJECT profile — the active-profile `access` only speaks for the
  // active profile, so a cross-profile page re-resolves it (accessForProfile). A view-only
  // grant renders a clean read-only page; the writes themselves stay gated server-side by
  // requireProfileWriteAccess in the actions.
  const canWrite = crossProfile
    ? accessForProfile(login.id, login.role, profileId) === "write"
    : activeAccess === "write";
  // The cross-profile write target the components stamp onto their posts (the #858 pattern);
  // undefined on the acting profile's own page, where writes take the active-profile path.
  const target = crossProfile ? profileId : undefined;

  const assembled = assembleIllnessEpisode(profileId, episode);
  const promoted = assembled.conditions.some((c) => c.fromEpisode);
  const bannerDay = episodeDayNumber(
    assembled.start,
    assembled.lastActiveDay ?? assembled.asOf
  );
  const bannerSubtitle = `${assembled.situation} · ${
    assembled.ongoing ? "ongoing" : "resolved"
  }${bannerDay != null ? ` · day ${bannerDay}` : ""}`;

  // Item 1: the SUGGEST-ONLY stale nudge, shown only when THIS episode is the current
  // open one AND it has gone quiet. Item 2: the school-return countdown, when a fever
  // has been logged in this (open) episode. Both format over the ONE gathers (#221).
  const staleNudge = canWrite ? staleEpisodeNudgeFor(profileId) : null;
  const showStaleNudge =
    staleNudge?.episodeId === episodeId ? staleNudge : null;
  const schoolReturn = assembled.ongoing
    ? schoolReturnStatusFor(profileId, assembled)
    : null;

  // Item 4: symptom photos attached in the episode window (rash progression). Read
  // through a dedicated gather — NOT part of assembleIllnessEpisode / the share payload
  // (the PHI default-exclude).
  const photos =
    assembled.firstDay && assembled.lastActiveDay
      ? getSymptomPhotosInRange(
          profileId,
          assembled.firstDay,
          assembled.lastActiveDay
        )
      : [];
  const inRangeEvents = getEpisodeInRangeEvents(
    profileId,
    assembled.firstDay,
    assembled.lastActiveDay
  );
  const comparison = assembled.ongoing
    ? episodeComparisonFor(profileId, episodeId)
    : null;
  // Item 6: the redose window + Log button — most useful for an OPEN episode (the 9pm
  // caregiver). Reuses the dashboard PRN widget over the SAME redoseWindowStatus (one
  // computation), never a second redose engine.
  const prnMeds =
    assembled.ongoing && canWrite
      ? getPrnMedicationsForQuickLog(profileId)
      : [];

  // Episode-end medication reconciliation (issue #880): the episode-associated meds the
  // "Feeling better" / stale-end checklist offers to close. Only for an open episode a
  // writer can end. The SAME gather the confirm action re-derives to validate the
  // selection server-side (one computation).
  const medReconciliation =
    assembled.ongoing && canWrite
      ? getEpisodeMedReconciliation(profileId, episodeId)
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
      <EpisodeIdentityBanner
        profile={subject}
        subtitle={bannerSubtitle}
        crossProfile={crossProfile}
      />
      <div className="mb-4 flex items-center justify-end">
        <EpisodeControls
          episodeId={episodeId}
          ongoing={assembled.ongoing}
          promoted={promoted}
          canWrite={canWrite}
          profileId={target}
          medReconciliation={medReconciliation}
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
          profileId={target}
          lastActivityDate={showStaleNudge.lastActivityDate}
          quietDays={showStaleNudge.quietDays}
          medReconciliation={medReconciliation}
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
          initial={getSymptomSeveritiesOnDate(profileId, logDate)}
          initialAlt={getSymptomSeveritiesOnDate(profileId, yesterday)}
          initialNotes={getSymptomNotesOnDate(profileId, logDate)}
          initialAltNotes={getSymptomNotesOnDate(profileId, yesterday)}
          symptoms={SYMPTOMS}
          customNames={getCustomSymptomNames(profileId)}
          rankedKeys={getSymptomLogOrder(profileId)}
          temperatureUnit={temperatureUnit}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          profileId={target}
        />
      )}
      {prnMeds.length > 0 && (
        <div className="mt-5">
          <QuickLogPrnWidget
            meds={prnMeds}
            tz={getTimezone(profileId)}
            profileId={target}
          />
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
          profileId={target}
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
          profileId={target}
        />
      )}
    </div>
  );
}
