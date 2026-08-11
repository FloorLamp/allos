import {
  getImagingStudiesForProfiles,
  getImagingStudyFollowUps,
  getPickerProviders,
  createVisitOffers,
} from "@/lib/queries";
import { stampSubjects, type ProfileScope } from "@/lib/scope";
import { getProfileAge } from "@/lib/settings";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import { today } from "@/lib/db";
import { cumulativeDose } from "@/lib/radiation-dose";
import ImagingStudyForm from "@/app/(app)/results/imaging/ImagingStudyForm";
import AddEntryPanel from "@/components/AddEntryPanel";
import ImagingStudyList from "@/app/(app)/results/imaging/ImagingStudyList";
import RadiationDoseCard from "@/app/(app)/results/imaging/RadiationDoseCard";
import { addImagingStudy } from "@/app/(app)/results/imaging/actions";

// The former /imaging index page body (#1042 phase 5), now the #imaging section
// of /results. Imaging studies: the profile's structured radiology studies —
// modality, body region, laterality, contrast, and the radiologist's impression —
// newest first, filterable by modality / region. Captured from an uploaded
// radiology report via AI extraction, or added manually. This is the NARRATIVE +
// METADATA home for imaging; numeric imaging metrics (DEXA T-scores, calcium
// score, EF, IMT) still live as `scan` biomarkers and trend there. Image pixels /
// DICOM are out of scope — Allos holds the report, not the images.
// Multi-view (#1328): the imaging STUDIES LIST reads the view-set with the SET-BASED
// getImagingStudiesForProfiles (registered cross-profile module) and gets subject chips
// + per-item write gates. The DERIVED surfaces — cumulative radiation dose, follow-up
// clock, create-visit offers — are per-profile read-time derivations (dose windows /
// today() / age) and stay on the ACTING profile (the #1096 scope-limit). Single view is
// byte-identical.
export default function ImagingSection({ scope }: { scope: ProfileScope }) {
  const profileId = scope.actingProfileId;
  const multi = scope.viewIds.length > 1;
  const studies = stampSubjects(
    scope,
    getImagingStudiesForProfiles(scope.viewIds)
  );
  const followUps = getImagingStudyFollowUps(profileId);
  // Cumulative radiation dose (#703): ONE pure computation over the ACTING profile's
  // studies (a per-profile dose window is never mixed across members), rendered as a
  // calm, informational trailing-window total. A child profile (age < 18) carries the
  // age-appropriate framing the app already applies to pediatric surfaces.
  const dose = cumulativeDose(
    studies.filter((s) => s.profileId === profileId),
    today(profileId)
  );
  const age = getProfileAge(profileId);
  const pediatric = age !== null && age < 18;
  // "Create a visit from this record?" (#1099): a study dated D with no encounter that
  // day.
  const createVisitOffersList = createVisitOffers(profileId, "imaging");

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div className="space-y-4">
        <div className="flex justify-end">
          <AddEntryPanel
            testId="add-imaging-panel"
            panelId="add-imaging-panel-body"
            label="Add imaging study"
            presentation="modal"
          >
            <ImagingStudyForm action={addImagingStudy} />
          </AddEntryPanel>
        </div>
        <CreateVisitFromRecord
          profileId={profileId}
          offers={createVisitOffersList}
        />
        <RadiationDoseCard cum={dose} pediatric={pediatric} />
        <ImagingStudyList
          items={studies}
          followUps={followUps}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
      </div>
    </ProviderOptionsProvider>
  );
}
