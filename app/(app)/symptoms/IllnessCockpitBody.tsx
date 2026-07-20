import { today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { getTimezone, getUnitPrefs } from "@/lib/settings";
import { SYMPTOMS } from "@/lib/symptoms";
import {
  getSymptomSeveritiesOnDate,
  getSymptomNotesOnDate,
  getSymptomLogOrder,
  getCustomSymptomNames,
  getPrnMedicationsForQuickLog,
  getPediatricFormContext,
  getEpisodeMedReconciliation,
} from "@/lib/queries";
import {
  episodeAlternateLogDate,
  type AssembledEpisode,
} from "@/lib/illness-episode-format";
import SymptomLogBar from "./SymptomLogBar";
import CockpitEndEpisode from "@/components/dashboard/CockpitEndEpisode";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import { staleEpisodeNudgeFor } from "@/lib/stale-episode-data";
import { schoolReturnStatusFor } from "@/lib/school-return-data";
import { schoolReturnCompactClause } from "@/lib/school-return";
import EpisodeLatestReadings from "@/components/illness/EpisodeLatestReadings";

// The full illness-cockpit BODY for one patient (issue #858) — the expanded content the
// hero shell (IllnessHero) reveals under the named header. It is the SAME machinery the
// dashboard Symptoms card gathered (the one-tap SymptomLogBar with symptoms + temp) plus
// the PRN dose log (the SAME redose computation the QuickLogPrn widget uses — one
// question, one computation) and the end-episode action. Rendered server-side (it needs
// profile-scoped reads) and passed into the client shell as a node, so ONE component
// serves the acting profile's cockpit and every household member's accordion cockpit.
//
// `crossProfile` is true for a household member (not the acting profile): the bar + PRN
// control + end button then carry the target `profileId` so their writes gate on THAT
// profile (requireProfileWriteAccess) without switching. On the acting profile's own
// cockpit it is false and every write takes the plain active-profile path.
export default function IllnessCockpitBody({
  profileId,
  loginId,
  episode,
  crossProfile,
}: {
  profileId: number;
  loginId: number;
  episode: AssembledEpisode;
  crossProfile: boolean;
}) {
  const date = today(profileId);
  // Match the episode page's backfill boundary: yesterday is only a valid choice when
  // it belongs to this episode. A same-day episode must not offer a dashboard write that
  // the episode page then correctly omits from its own timeline.
  const altDate =
    episodeAlternateLogDate(episode.ongoing, episode.firstDay, date) ??
    undefined;
  const temperatureUnit = getUnitPrefs(loginId).temperatureUnit;
  const tz = getTimezone(profileId);
  // The write target the bar/control/end button post — only for a household member's
  // cockpit; the acting profile's own cockpit omits it (active-profile write path).
  const target = crossProfile ? profileId : undefined;

  // Item 2: the school-return countdown (when a fever has been logged this episode) +
  // Item 1: the suggest-only stale nudge (this open episode gone quiet) — both format
  // over the ONE gathers (#221), shown on the cockpit alongside the episode page.
  const schoolReturn = schoolReturnStatusFor(profileId, episode);
  const staleNudge = staleEpisodeNudgeFor(profileId);
  const showStaleNudge =
    staleNudge != null && staleNudge.episodeId === episode.id
      ? staleNudge
      : null;

  // Episode-end medication reconciliation (issue #880): the episode-associated meds the
  // "Feeling better" / stale-end checklist offers to close, shared with the episode page
  // via the ONE gather.
  const medReconciliation =
    episode.id != null
      ? getEpisodeMedReconciliation(profileId, episode.id)
      : [];

  const prnMeds = getPrnMedicationsForQuickLog(profileId);

  return (
    <div className="mt-3 flex flex-col" data-testid="illness-cockpit-body">
      <EpisodeLatestReadings
        episode={episode}
        temperatureUnit={temperatureUnit}
        timeZone={tz}
        nowIso={clockNow().toISOString()}
        linkMedication
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
        className="mb-4 border-b border-black/5 pb-4 dark:border-white/5"
      />

      <section>
        <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          Symptoms &amp; Temperature
        </h3>
        <SymptomLogBar
          date={date}
          altDate={altDate}
          initial={getSymptomSeveritiesOnDate(profileId, date)}
          initialAlt={
            altDate ? getSymptomSeveritiesOnDate(profileId, altDate) : undefined
          }
          initialNotes={getSymptomNotesOnDate(profileId, date)}
          initialAltNotes={
            altDate ? getSymptomNotesOnDate(profileId, altDate) : undefined
          }
          symptoms={SYMPTOMS}
          customNames={getCustomSymptomNames(profileId)}
          rankedKeys={getSymptomLogOrder(profileId)}
          suggestActivateIllness={false}
          showTemperature
          temperatureUnit={temperatureUnit}
          timeZone={tz}
          profileId={target}
          showTitle={false}
        />
      </section>

      {showStaleNudge && (
        <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
          <StaleEpisodeNudge
            episodeId={showStaleNudge.episodeId}
            profileId={target}
            lastActivityDate={showStaleNudge.lastActivityDate}
            quietDays={showStaleNudge.quietDays}
            medReconciliation={medReconciliation}
          />
        </div>
      )}

      {(prnMeds.length > 0 || !crossProfile) && (
        <div
          className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
          data-testid="cockpit-prn"
        >
          <IllnessMedicationLogger
            meds={prnMeds}
            tz={tz}
            profileId={target}
            pediatric={getPediatricFormContext(profileId)}
            canAdd={!crossProfile}
            nowIso={clockNow().toISOString()}
          />
        </div>
      )}

      {episode.id != null && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-black/5 pt-4 dark:border-white/5">
          <CockpitEndEpisode
            episodeId={episode.id}
            profileId={target}
            meds={medReconciliation}
          />
        </div>
      )}
    </div>
  );
}
