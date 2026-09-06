import { PICKER_SYMPTOMS } from "@/lib/symptoms";
import type {
  AssembledEpisode,
  EpisodeCollapsedStatus,
} from "@/lib/illness-episode-format";
import SymptomLogBar from "./SymptomLogBar";
import CockpitEndEpisode from "@/components/dashboard/CockpitEndEpisode";
import CockpitRecoveryHeader, {
  type CockpitFactIdentity,
} from "@/components/illness/CockpitRecoveryHeader";
import IllnessMedicationLogger from "@/components/illness/IllnessMedicationLogger";
import { IntakeOptionsProvider } from "@/components/IntakeOptionsContext";
import StaleEpisodeNudge from "@/components/illness/StaleEpisodeNudge";
import type { DashboardIllnessCockpitModel } from "@/lib/dashboard-illness-cockpit";
import { CockpitDayProvider } from "@/components/illness/CockpitDayContext";
import { DoseOfferProvider } from "@/components/illness/DoseOfferContext";

// The full illness-cockpit BODY for one patient (issue #858), recovery-led and compact
// since #4752. It is the SAME machinery it always was — the one-tap SymptomLogBar with
// symptoms + temperature, the PRN dose controls over the SAME redose computation
// QuickLogPrnContent uses, and the end-episode action — rearranged so the thing a
// caregiver came for leads:
//
//   1. THE HEADER IS THE STATUS. The fever-free ring, the sentence about the person,
//      the Illness · Day-N tag, one prose line folding last-temp and last-meds, and
//      "Feeling better" beside the countdown rather than at the card's bottom edge.
//   2. A READABLE MEASURE. ~880px, centered — declared on the cockpit container in
//      `IllnessNowGroup` so the collapsed accordion line and this body share one
//      column. The stat-spread and the eye-travel from a med's name to its own button
//      dissolve by construction rather than by a desktop rule.
//   3. EXPANSIONS OPEN IN PLACE. The symptom picker, the temperature entry and the med
//      panel each open into a quiet inset panel beneath their own row. Nothing
//      navigates and nothing outside the panel moves.
//
// Rendered server-side (it needs profile-scoped reads) and passed into the client
// shell as a node, so ONE component serves the acting profile's cockpit and every
// household member's accordion cockpit.
//
// `crossProfile` is true for a household member (not the acting profile): the bar +
// med controls + end button then carry the target `profileId` so their writes gate on
// THAT profile (requireProfileWriteAccess) without switching. On the acting profile's
// own cockpit it is false and every write takes the plain active-profile path.
export default function IllnessCockpitBody({
  profileId,
  episode,
  status,
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
  // The SAME collapsed reading the accordion line above this body renders (#4752
  // item 1) — passed in rather than recomputed, so the header and the line it
  // expands from can never state two different last doses.
  status: EpisodeCollapsedStatus;
  crossProfile: boolean;
  canWrite: boolean;
  ownsSharedProfileControls: boolean;
  hasPluralOpenEpisodes: boolean;
  profileDisplayName: string;
  model: DashboardIllnessCockpitModel;
  temperatureIdentity?: CockpitFactIdentity | null;
  medicationIdentity?: CockpitFactIdentity | null;
}) {
  const { date, temperatureUnit, timeZone, nowIso, feverFree } = model;
  const controls = model.controls;
  // The write target the bar/control/end button post — only for a household member's
  // cockpit; the acting profile's own cockpit omits it (active-profile write path).
  const target = crossProfile ? profileId : undefined;

  // THE SEAMS STEP DOWN ONE UNIT ON A PHONE (#3460). The cockpit is the single
  // tallest block on a sick day's dashboard, and its internal rhythm was 16px at
  // every seam. Below `sm` each `*-4` seam becomes `*-3`; from `sm` up the rhythm is
  // unchanged. NOTHING is removed — every symptom, med, reading, temperature and
  // footer control is still here, which is the safety ruling this spacing pass is
  // explicitly not allowed to touch — and no row loses its tap floor.
  return (
    <CockpitDayProvider date={date} altDate={controls?.altDate} tz={timeZone}>
      {/* The fold and the persistent Meds section are siblings, so the "one dose
          prompt at a time" signal lives above both (#4712 ruling part 2). */}
      <DoseOfferProvider>
        <div
          className="mt-3 flex w-full flex-col"
          data-testid="illness-cockpit-body"
        >
          <CockpitRecoveryHeader
            status={status}
            recovery={feverFree}
            temperatureIdentity={temperatureIdentity}
            medicationIdentity={medicationIdentity}
            action={
              canWrite && controls && episode.id != null ? (
                <CockpitEndEpisode
                  episodeId={episode.id}
                  profileId={target}
                  meds={controls.medReconciliation}
                />
              ) : undefined
            }
          />

          {canWrite && controls ? (
            <section className="mt-3 border-t border-black/5 pt-3 sm:mt-4 sm:pt-4 dark:border-white/5">
              {ownsSharedProfileControls && hasPluralOpenEpisodes ? (
                <p
                  className="mb-2 text-xs text-slate-500 dark:text-slate-400"
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
                // THE FOLD OFFERS THE DOSE, AND THE MEDS SECTION BELOW YIELDS WHILE IT
                // DOES (#4712, owner ruling 2026-09-04 11:20 UTC part 2). These props
                // fed nobody for a while, because `antipyreticPrnMeds` is
                // `controls.prnMeds` narrowed and the persistent section was already
                // showing every one of those chips — two `cockpit-med-chip-<id>` for
                // one medication inside one situation group. The section's `yieldsTo`
                // below is the other half of this: one prompt for one dose, so wiring
                // these without it is what would put the second chip back.
                antipyreticMeds={controls.antipyreticPrnMeds}
                intakeContext={controls.intakeForm}
                nowIso={nowIso}
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
                    intakeContext={controls.intakeForm}
                    canAdd={!crossProfile}
                    nowIso={nowIso}
                    yieldsTo={controls.antipyreticPrnMeds}
                  />
                </IntakeOptionsProvider>
              </div>
            )}
        </div>
      </DoseOfferProvider>
    </CockpitDayProvider>
  );
}
