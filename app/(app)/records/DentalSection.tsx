import {
  getDentalProcedures,
  getDentalProcedureFollowUps,
  getPickerProviders,
  createVisitOffers,
} from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
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
//
// MULTI-VIEW (#2557): the record list reads every profile in view through the
// loop-composition helper and stamps each row with its subject, so the table can name
// whose record it is and post that row's own profile on an edit or delete. Everything
// else on this pane stays ACTING-PROFILE work, and deliberately: the add form creates
// a record for whoever is acting, the recheck follow-up writes the acting profile's
// care plan (the #1328 scope-limit precedent Imaging set), and "create a visit from
// this record" builds an encounter on the acting profile's timeline. Widening any of
// those would be a wrong-target write, not a feature.
export default function DentalSection({ scope }: { scope: ProfileScope }) {
  const multi = scope.viewIds.length > 1;
  const records = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getDentalProcedures(pid))
  );
  const followUps = getDentalProcedureFollowUps(scope.actingProfileId);
  // "Create a visit from this record?" (#1099): a completed procedure dated D with no
  // encounter that day.
  const createVisitOffersList = createVisitOffers(
    scope.actingProfileId,
    "dental"
  );

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
          profileId={scope.actingProfileId}
          offers={createVisitOffersList}
        />
        <DentalProcedureList
          items={records}
          followUps={followUps}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          This is a record of dental work and findings, not a clinical charting
          tool.
        </p>
      </div>
    </ProviderOptionsProvider>
  );
}
