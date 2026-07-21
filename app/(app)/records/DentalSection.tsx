import {
  getDentalProcedures,
  getDentalProcedureFollowUps,
  getProviderNames,
  createVisitOffers,
} from "@/lib/queries";
import ProviderDatalist from "@/components/ProviderDatalist";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import DentalProcedureForm from "@/app/(app)/dental/DentalProcedureForm";
import DentalProcedureList from "@/app/(app)/dental/DentalProcedureList";
import { addDentalProcedure } from "@/app/(app)/dental/actions";

// Dental (former /dental index, #1042 final tail): the profile's structured dental
// records — tooth-anchored procedures (fillings/crowns/extractions with tooth +
// surface + CDT code) and exam findings ("watch #14, recheck in 6 months") that seed
// the follow-up loop — newest first, now the data-gated #dental section of /records.
// Captured from an uploaded dental exam/treatment record via AI extraction, or added
// manually. Periodontal MEASUREMENTS (pocket depth, bleeding-on-probing) are
// biomarkers and trend on Results; dental X-rays are imaging studies. Server Actions
// + client components stayed in app/(app)/dental/; the page body moved here.
export default function DentalSection({ profileId }: { profileId: number }) {
  const records = getDentalProcedures(profileId);
  const followUps = getDentalProcedureFollowUps(profileId);
  // "Create a visit from this record?" (#1099): a completed procedure dated D with no
  // encounter that day.
  const createVisitOffersList = createVisitOffers(profileId, "dental");

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      {/* Shared provider picker options for the add + edit forms (#1088). */}
      <ProviderDatalist names={getProviderNames()} />
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <CreateVisitFromRecord
          profileId={profileId}
          offers={createVisitOffersList}
        />
        <DentalProcedureList items={records} followUps={followUps} />
      </div>

      <div className="min-w-0 space-y-4">
        <DentalProcedureForm action={addDentalProcedure} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          Informational only, not medical advice. This is a record of dental
          work and findings, not a clinical charting tool.
        </p>
      </div>
    </div>
  );
}
