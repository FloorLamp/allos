import {
  getDentalProcedures,
  getDentalProcedureFollowUps,
  getPickerProviders,
  createVisitOffers,
} from "@/lib/queries";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import AddEntryPanel from "@/components/AddEntryPanel";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import DentalProcedureForm from "@/app/(app)/records/specialty/dental/DentalProcedureForm";
import DentalProcedureList from "@/app/(app)/records/specialty/dental/DentalProcedureList";
import { addDentalProcedure } from "@/app/(app)/records/specialty/dental/actions";

// Dental (former /dental index, #1042 final tail): the profile's structured dental
// records — tooth-anchored procedures (fillings/crowns/extractions with tooth +
// surface + CDT code) and exam findings ("watch #14, recheck in 6 months") that seed
// the follow-up loop — newest first, now the data-gated #dental section of /records.
// Captured from an uploaded dental exam/treatment record via AI extraction, or added
// manually. Periodontal MEASUREMENTS (pocket depth, bleeding-on-probing) are
// biomarkers and trend on Results; dental X-rays are imaging studies. Server Actions
// + client components stayed in app/(app)/records/specialty/dental/; the page body moved here.
export default function DentalSection({ profileId }: { profileId: number }) {
  const records = getDentalProcedures(profileId);
  const followUps = getDentalProcedureFollowUps(profileId);
  // "Create a visit from this record?" (#1099): a completed procedure dated D with no
  // encounter that day.
  const createVisitOffersList = createVisitOffers(profileId, "dental");

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div className="space-y-6">
        <AddEntryPanel
          testId="add-dental-record-panel"
          panelId="add-dental-record-panel-body"
          label="Add dental record"
          presentation="modal"
        >
          <DentalProcedureForm action={addDentalProcedure} />
        </AddEntryPanel>
        <CreateVisitFromRecord
          profileId={profileId}
          offers={createVisitOffersList}
        />
        <DentalProcedureList items={records} followUps={followUps} />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          This is a record of dental work and findings, not a clinical charting
          tool.
        </p>
      </div>
    </ProviderOptionsProvider>
  );
}
