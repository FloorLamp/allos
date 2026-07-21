import {
  getImagingStudies,
  getImagingStudyFollowUps,
  getProviderNames,
  createVisitOffers,
} from "@/lib/queries";
import { getUserAge } from "@/lib/settings";
import ProviderDatalist from "@/components/ProviderDatalist";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import { today } from "@/lib/db";
import { cumulativeDose } from "@/lib/radiation-dose";
import ImagingStudyForm from "@/app/(app)/imaging/ImagingStudyForm";
import ImagingStudyList from "@/app/(app)/imaging/ImagingStudyList";
import RadiationDoseCard from "@/app/(app)/imaging/RadiationDoseCard";
import { addImagingStudy } from "@/app/(app)/imaging/actions";

// The former /imaging index page body (#1042 phase 5), now the #imaging section
// of /results. Imaging studies: the profile's structured radiology studies —
// modality, body region, laterality, contrast, and the radiologist's impression —
// newest first, filterable by modality / region. Captured from an uploaded
// radiology report via AI extraction, or added manually. This is the NARRATIVE +
// METADATA home for imaging; numeric imaging metrics (DEXA T-scores, calcium
// score, EF, IMT) still live as `scan` biomarkers and trend there. Image pixels /
// DICOM are out of scope — Allos holds the report, not the images.
export default function ImagingSection({ profileId }: { profileId: number }) {
  const studies = getImagingStudies(profileId);
  const followUps = getImagingStudyFollowUps(profileId);
  // Cumulative radiation dose (#703): ONE pure computation over the studies, rendered
  // as a calm, informational trailing-window total. A child profile (age < 18) carries
  // the age-appropriate framing the app already applies to pediatric surfaces.
  const dose = cumulativeDose(studies, today(profileId));
  const age = getUserAge(profileId);
  const pediatric = age !== null && age < 18;
  // "Create a visit from this record?" (#1099): a study dated D with no encounter that
  // day.
  const createVisitOffersList = createVisitOffers(profileId, "imaging");

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Shared provider picker options for the add + edit forms (#1088). */}
      <ProviderDatalist names={getProviderNames()} />
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <CreateVisitFromRecord
          profileId={profileId}
          offers={createVisitOffersList}
        />
        <RadiationDoseCard cum={dose} pediatric={pediatric} />
        <ImagingStudyList items={studies} followUps={followUps} />
      </div>

      <div className="min-w-0 space-y-4">
        <ImagingStudyForm action={addImagingStudy} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Informational only, not medical advice. Allos stores the imaging
          report, not the images themselves (DICOM is out of scope).
        </p>
      </div>
    </div>
  );
}
