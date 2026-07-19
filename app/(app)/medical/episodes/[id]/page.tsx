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
import EpisodeIdentityBanner from "@/components/illness/EpisodeIdentityBanner";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
  getPrnMedicationsForQuickLog,
  getEpisodeMedReconciliation,
  getPediatricFormContext,
} from "@/lib/queries";
import {
  getDisplayFormatPrefs,
  getTimezone,
  getUnitPrefs,
} from "@/lib/settings";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { SYMPTOMS } from "@/lib/symptoms";
import { isRealIsoDate } from "@/lib/date";
import { episodeAlternateLogDate } from "@/lib/illness-episode-format";
import { getEpisodeInRangeEvents } from "@/lib/illness-episode-events";
import { episodeComparisonFor } from "@/lib/illness-episode-compare";
import { gatherHouseholdEpisodeContext } from "@/lib/household-history";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import HouseholdEpisodeContextCard from "@/components/household/HouseholdEpisodeContextCard";
import EpisodeComparison from "@/components/illness/EpisodeComparison";
import EpisodeSummary, {
  EpisodeSummaryFooter,
} from "@/components/illness/EpisodeSummary";
import EpisodeControls from "@/components/illness/EpisodeControls";
import EpisodeLifecycleControl from "@/components/illness/EpisodeLifecycleControl";
import EpisodeLogPanel from "@/components/illness/EpisodeLogPanel";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import SymptomPhotoStrip from "@/components/illness/SymptomPhotoStrip";
import { getSymptomPhotosInRange } from "@/lib/symptom-photo-write";
import { staleEpisodeNudgeFor } from "@/lib/stale-episode-data";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { schoolReturnCompactClause } from "@/lib/school-return";
import CardGroup, { CardGroupSection } from "@/components/CardGroup";
import PageContainer from "@/components/PageContainer";
import { episodeReopenEligibility } from "@/lib/illness-episode-reopen";
import { IconCamera } from "@tabler/icons-react";

export const dynamic = "force-dynamic";

// The illness-episode detail page (issues #801/#856/#879). Authed. UNLIKE the encounters
// `[id]` precedent (which hard-scopes to the active profile, so guessing another id 404s),
// this page resolves the episode across the viewer's ACCESSIBLE profiles (issue #879): a
// caregiver following the household hero's "More details" link into another accessible
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
  const formatPrefs = getDisplayFormatPrefs(login.id);

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
  const timeZone = getTimezone(profileId);
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
  const canReopen =
    episodeReopenEligibility(row.ended_at, assembled.asOf).kind === "eligible";
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
  const episodeMedicationIds = new Set(
    assembled.medications.map((medication) => medication.itemId)
  );
  const prnMeds =
    assembled.ongoing && canWrite
      ? getPrnMedicationsForQuickLog(profileId).sort((a, b) => {
          return (
            Number(episodeMedicationIds.has(b.id)) -
              Number(episodeMedicationIds.has(a.id)) ||
            b.count - a.count ||
            a.name.localeCompare(b.name)
          );
        })
      : [];
  const canAddMedication = assembled.ongoing && canWrite && !crossProfile;

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
  // Never offer a backfill day outside this episode's own window. In particular, an
  // episode opened today must not save a "yesterday" symptom that then disappears from
  // its summary because membership begins today. Unknown-start episodes remain open-
  // ended toward the past, so yesterday is valid for them.
  const altLogDate =
    episodeAlternateLogDate(assembled.ongoing, rangeStart, logDate) ??
    undefined;
  const hasCareContext = showStaleNudge != null || comparison != null;
  const hasUpdateWorkspace = canWrite;

  // Household context (issue #1009 Ask 3): other ACCESSIBLE members' episodes that
  // overlap or closely precede/follow THIS episode's window — "did this go around the
  // house?" answered in place. Grant-scoped exactly like the merged history: only the
  // viewing login's accessible profiles (minus the subject) are considered, so an
  // ungranted member never appears. The SAME summarize gather the merged view uses,
  // windowed to this episode's dates (one computation — no second engine). Renders
  // NOTHING (not an empty shell) when there are no other accessible profiles or no
  // overlapping/adjacent illness.
  const otherProfileIds = accessible
    .map((p) => p.id)
    .filter((pid) => pid !== profileId);
  const householdContexts =
    otherProfileIds.length > 0
      ? gatherHouseholdEpisodeContext(
          profileId,
          {
            firstDay: assembled.firstDay,
            lastActiveDay: assembled.lastActiveDay,
          },
          otherProfileIds
        )
      : [];
  const householdNames = disambiguateProfileNames(accessible);
  const accessibleById = new Map(accessible.map((p) => [p.id, p]));

  return (
    <PageContainer width="reading" className="mx-auto space-y-5">
      <EpisodeSummary
        episode={assembled}
        note={row.note}
        outcome={row.outcome}
        temperatureUnit={temperatureUnit}
        timeZone={timeZone}
        formatPrefs={formatPrefs}
        canEdit={canWrite}
        linkLatestMedication
        collapsePeakSymptoms
        eventProfileId={target}
        identity={
          <EpisodeIdentityBanner
            profile={subject}
            crossProfile={crossProfile}
          />
        }
        careEvents={inRangeEvents}
        feverFree={
          schoolReturn
            ? {
                label: schoolReturnCompactClause(schoolReturn).replace(
                  /^fever-free/,
                  "Fever-free"
                ),
                met: schoolReturn.met,
              }
            : null
        }
        timelineActions={
          <EpisodeControls
            episodeId={episodeId}
            ongoing={assembled.ongoing}
            promoted={promoted}
            canWrite={canWrite}
            profileId={target}
            editor={{
              startedAt: row.started_at,
              endedAt: row.ended_at,
              note: row.note,
              outcome: row.outcome,
            }}
          />
        }
        timelineTools={
          hasUpdateWorkspace ? (
            <>
              {canWrite && (
                <EpisodeLogPanel
                  episodeId={episodeId}
                  ongoing={assembled.ongoing}
                  date={logDate}
                  altDate={altLogDate}
                  initial={getSymptomSeveritiesOnDate(profileId, logDate)}
                  initialAlt={
                    altLogDate
                      ? getSymptomSeveritiesOnDate(profileId, altLogDate)
                      : undefined
                  }
                  initialNotes={getSymptomNotesOnDate(profileId, logDate)}
                  initialAltNotes={
                    altLogDate
                      ? getSymptomNotesOnDate(profileId, altLogDate)
                      : undefined
                  }
                  symptoms={SYMPTOMS}
                  customNames={getCustomSymptomNames(profileId)}
                  rankedKeys={getSymptomLogOrder(profileId)}
                  temperatureUnit={temperatureUnit}
                  timeZone={timeZone}
                  rangeStart={rangeStart}
                  rangeEnd={rangeEnd}
                  profileId={target}
                  photoControl={
                    <label
                      htmlFor="episode-symptom-photo-input"
                      className="btn-ghost btn-sm cursor-pointer"
                      data-testid="episode-add-photo-shortcut"
                    >
                      <IconCamera className="h-3.5 w-3.5" stroke={1.75} />
                      Add photo
                    </label>
                  }
                />
              )}

              {(prnMeds.length > 0 || canAddMedication) && (
                <div
                  className={
                    canWrite
                      ? "mt-5 border-t border-black/5 pt-5 dark:border-white/5"
                      : undefined
                  }
                >
                  <IllnessMedicationLogger
                    meds={prnMeds}
                    tz={getTimezone(profileId)}
                    profileId={target}
                    pediatric={getPediatricFormContext(profileId)}
                    canAdd={canAddMedication}
                  />
                </div>
              )}
            </>
          ) : undefined
        }
        timelineAfterHistory={
          photos.length > 0 || canWrite ? (
            <>
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
              {canWrite && (
                <EpisodeLifecycleControl
                  episodeId={episodeId}
                  ongoing={assembled.ongoing}
                  canReopen={canReopen}
                  profileId={target}
                  medReconciliation={medReconciliation}
                />
              )}
            </>
          ) : undefined
        }
      />

      {hasCareContext && (
        <CardGroup
          title="Episode context"
          description="Status reminders and comparison with past episodes."
          data-testid="episode-care-context"
        >
          {showStaleNudge && (
            <CardGroupSection>
              <StaleEpisodeNudge
                episodeId={showStaleNudge.episodeId}
                profileId={target}
                lastActivityDate={showStaleNudge.lastActivityDate}
                quietDays={showStaleNudge.quietDays}
                medReconciliation={medReconciliation}
              />
            </CardGroupSection>
          )}
          {comparison && (
            <CardGroupSection>
              <EpisodeComparison comparison={comparison} />
            </CardGroupSection>
          )}
        </CardGroup>
      )}

      {householdContexts.length > 0 && (
        <HouseholdEpisodeContextCard
          contexts={householdContexts}
          profilesById={accessibleById}
          nameFor={(pid) => householdNames.get(pid) ?? "Someone"}
        />
      )}

      <EpisodeSummaryFooter
        generatedAt={new Date().toISOString()}
        formatPrefs={formatPrefs}
      />
    </PageContainer>
  );
}
