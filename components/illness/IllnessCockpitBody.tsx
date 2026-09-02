import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import type { AssembledEpisode } from "@/lib/illness-episode-format";
import SymptomLogBar from "./SymptomLogBar";
import CockpitEndEpisode from "@/components/dashboard/CockpitEndEpisode";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { IntakeOptionsProvider } from "@/components/IntakeOptionsContext";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import EpisodeLatestReadings from "@/components/illness/EpisodeLatestReadings";
import type { DashboardIllnessCockpitModel } from "@/lib/dashboard-illness-cockpit";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";

// The full illness-cockpit BODY for one patient (issue #858) — the expanded content the
// illness Now group reveals under the named header. It is the SAME machinery the
// dashboard Symptoms card gathered (the one-tap SymptomLogBar with symptoms + temp) plus
// the PRN dose log (the SAME redose computation QuickLogPrnContent uses — one
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
  ownsSharedProfileControls,
  hasPluralOpenEpisodes,
  profileDisplayName,
  model,
  temperatureIdentity,
  medicationIdentity,
}: {
  profileId: number;
  episode: AssembledEpisode;
  crossProfile: boolean;
  canWrite: boolean;
  ownsSharedProfileControls: boolean;
  hasPluralOpenEpisodes: boolean;
  profileDisplayName: string;
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

  // THE SEAMS STEP DOWN ONE UNIT ON A PHONE (#3460). The cockpit is the single
  // tallest block on a sick day's dashboard, and its internal rhythm was 16px at
  // every seam. Below `sm` each `*-4` seam becomes `*-3` and the section headers'
  // `mb-3` becomes `mb-2`; from `sm` up the rhythm is unchanged. NOTHING is removed
  // — every symptom, med, reading, temperature and footer control is still here,
  // which is the safety ruling this spacing pass is explicitly not allowed to touch
  // — and no row loses its tap floor (the declared `min-h-*` is untouched
  // everywhere; it reads `min-h-11` since #3514 ruled the floor at 44).
  return (
    <CockpitDayProvider date={date} altDate={controls?.altDate} tz={timeZone}>
      <div className="mt-3 flex flex-col" data-testid="illness-cockpit-body">
        <EpisodeLatestReadings
          episode={episode}
          temperatureUnit={temperatureUnit}
          timeZone={timeZone}
          nowIso={nowIso}
          linkMedication
          feverFree={feverFree}
          className="mb-3 border-b border-black/5 pb-3 sm:mb-4 sm:pb-4 dark:border-white/5"
          temperatureIdentity={temperatureIdentity}
          medicationIdentity={medicationIdentity}
        />

        {canWrite && controls ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-slate-700 sm:mb-3 dark:text-slate-200">
              Symptoms
            </h3>
            {ownsSharedProfileControls && hasPluralOpenEpisodes ? (
              <p
                className="mb-3 text-xs text-slate-500 dark:text-slate-400"
                data-testid="illness-shared-profile-controls-context"
              >
                Temperature and medications are shared across{" "}
                {profileDisplayName}
                &apos;s open episodes.
              </p>
            ) : null}
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
              showTemperature={ownsSharedProfileControls}
              temperatureUnit={temperatureUnit}
              timeZone={timeZone}
              profileId={target}
              episodeId={episode.id ?? undefined}
              showTitle={false}
              analysisHref={crossProfile ? undefined : "/trends/symptoms"}
            />
          </section>
        ) : null}

        {canWrite && controls?.staleNudge && (
          <div className="mt-3 border-t border-black/5 pt-3 sm:mt-4 sm:pt-4 dark:border-white/5">
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
          ownsSharedProfileControls &&
          (controls.prnMeds.length > 0 || !crossProfile) && (
            <div
              className="mt-3 border-t border-black/5 pt-3 sm:mt-4 sm:pt-4 dark:border-white/5"
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
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/5 pt-3 sm:mt-4 sm:pt-4 dark:border-white/5">
            <CockpitEndEpisode
              episodeId={episode.id}
              profileId={target}
              meds={controls.medReconciliation}
            />
          </div>
        )}
      </div>
    </CockpitDayProvider>
  );
}
