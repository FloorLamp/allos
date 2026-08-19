import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import type { AssembledEpisode } from "@/lib/illness-episode-format";
import SymptomLogBar from "./SymptomLogBar";
import CockpitEndEpisode from "@/components/dashboard/CockpitEndEpisode";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { IntakeOptionsProvider } from "@/components/IntakeOptionsContext";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import EpisodeLatestReadings from "@/components/illness/EpisodeLatestReadings";
import type { DashboardIllnessCockpitModel } from "@/lib/dashboard-illness-cockpit";

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
  episode,
  crossProfile,
  canWrite,
  model,
  temperatureIdentity,
  medicationIdentity,
}: {
  profileId: number;
  episode: AssembledEpisode;
  crossProfile: boolean;
  canWrite: boolean;
  model: DashboardIllnessCockpitModel;
  temperatureIdentity?: {
    candidateId: string;
    factKey: string;
    groupKey: string;
  } | null;
  medicationIdentity?: {
    candidateId: string;
    factKey: string;
    groupKey: string;
  } | null;
}) {
  const { date, temperatureUnit, timeZone, nowIso, feverFree } = model;
  const controls = model.controls;
  // The write target the bar/control/end button post — only for a household member's
  // cockpit; the acting profile's own cockpit omits it (active-profile write path).
  const target = crossProfile ? profileId : undefined;

  return (
    <div className="mt-3 flex flex-col" data-testid="illness-cockpit-body">
      <EpisodeLatestReadings
        episode={episode}
        temperatureUnit={temperatureUnit}
        timeZone={timeZone}
        nowIso={nowIso}
        linkMedication
        feverFree={feverFree}
        className="mb-4 border-b border-black/5 pb-4 dark:border-white/5"
        temperatureIdentity={temperatureIdentity}
        medicationIdentity={medicationIdentity}
      />

      {canWrite && controls ? (
        <section>
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Symptoms &amp; Temperature
          </h3>
          <SymptomLogBar
            date={date}
            altDate={controls.altDate}
            initial={controls.initial}
            initialAlt={controls.initialAlt}
            initialNotes={controls.initialNotes}
            initialAltNotes={controls.initialAltNotes}
            symptoms={PICKER_SYMPTOMS}
            customNames={controls.customNames}
            rankedKeys={controls.rankedKeys}
            suggestActivateIllness={false}
            showTemperature
            temperatureUnit={temperatureUnit}
            timeZone={timeZone}
            profileId={target}
            showTitle={false}
          />
        </section>
      ) : null}

      {canWrite && controls?.staleNudge && (
        <div className="mt-4 border-t border-black/5 pt-4 dark:border-white/5">
          <StaleEpisodeNudge
            episodeId={controls.staleNudge.episodeId}
            profileId={target}
            lastActivityDate={controls.staleNudge.lastActivityDate}
            quietDays={controls.staleNudge.quietDays}
            medReconciliation={controls.medReconciliation}
          />
        </div>
      )}

      {canWrite &&
        controls &&
        (controls.prnMeds.length > 0 || !crossProfile) && (
          <div
            className="mt-4 border-t border-black/5 pt-4 dark:border-white/5"
            data-testid="cockpit-prn"
          >
            {/* Its inline quick-add reads the SAME ranked medication options the
              Medications page offers (#1677) — resolved for the patient whose cockpit
              this is, not for whoever is looking at it. */}
            <IntakeOptionsProvider options={controls.intakeOptions}>
              <IllnessMedicationLogger
                meds={controls.prnMeds}
                tz={timeZone}
                profileId={target}
                pediatric={controls.pediatric}
                canAdd={!crossProfile}
                nowIso={nowIso}
              />
            </IntakeOptionsProvider>
          </div>
        )}

      {canWrite && controls && episode.id != null && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-black/5 pt-4 dark:border-white/5">
          <CockpitEndEpisode
            episodeId={episode.id}
            profileId={target}
            meds={controls.medReconciliation}
          />
        </div>
      )}
    </div>
  );
}
