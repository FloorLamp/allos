import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getOpticalPrescriptions,
  getPickerProviders,
  createVisitOffers,
} from "@/lib/queries";
import { readForProfiles, stampSubjects, type ProfileScope } from "@/lib/scope";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import AddEntryPanel from "@/components/AddEntryPanel";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import { today } from "@/lib/db";
import OpticalPrescriptionForm from "@/app/(app)/records/specialty/vision/OpticalPrescriptionForm";
import OpticalPrescriptionList from "@/app/(app)/records/specialty/vision/OpticalPrescriptionList";
import OpticalProgression from "@/app/(app)/records/specialty/vision/OpticalProgression";
import { addOpticalPrescription } from "@/app/(app)/records/specialty/vision/actions";

// Vision / eye care (former /vision index, #1042 final tail): the profile's
// structured optical (eyeglass/contact) prescriptions — per-eye
// sphere/cylinder/axis/add, PD, and the contacts extras — newest issued first,
// with a per-eye sphere-over-time progression (the "is my myopia getting worse?"
// view), now the data-gated #vision section of /records. Captured from an uploaded
// Rx slip / eye-exam report via AI extraction (Data → Import), or added manually.
// The recurring eye-exam reminder lives on the existing vision_exam preventive
// rule, not duplicated here (#697). Server Actions + client components stayed in
// their route-independent module (app/(app)/records/specialty/vision/); the page body moved here.
//
// MULTI-VIEW (#2557): the prescription list reads every profile in view and stamps
// each row's subject, so an edit or delete posts the ROW's profile. The PROGRESSION
// chart stays acting-only — "is my myopia getting worse?" is one person's question,
// and plotting two members' spheres on one axis would answer a question nobody asked.
// The add form and the create-a-visit offer stay acting-only for the same reason the
// Dental pane's do: they write, and the actor is their target.
export default function VisionSection({ scope }: { scope: ProfileScope }) {
  const multi = scope.viewIds.length > 1;
  const prescriptions = stampSubjects(
    scope,
    readForProfiles(scope.viewIds, (pid) => getOpticalPrescriptions(pid))
  );
  const actingPrescriptions = getOpticalPrescriptions(scope.actingProfileId);
  // "Create a visit from this record?" (#1099): Rx dated D with no encounter that day.
  const createVisitOffersList = createVisitOffers(
    scope.actingProfileId,
    "optical"
  );
  // The expiry badge is a per-profile-context question (a member's own timezone
  // decides their today), so it is resolved once per profile in view rather than
  // once for the actor and reused — the AGENTS.md cross-profile rule.
  const todayByProfile = Object.fromEntries(
    scope.viewIds.map((pid) => [pid, today(pid)])
  );

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div className="space-y-6">
        <AddEntryPanel
          testId="add-prescription-panel"
          panelId="add-prescription-panel-body"
          label="Add prescription"
          presentation="modal"
        >
          <OpticalPrescriptionForm action={addOpticalPrescription} />
        </AddEntryPanel>
        <CreateVisitFromRecord
          profileId={scope.actingProfileId}
          offers={createVisitOffersList}
        />
        <OpticalProgression
          items={actingPrescriptions}
          formatPrefs={getDisplayFormatPrefs(scope.loginId)}
        />
        <OpticalPrescriptionList
          items={prescriptions}
          todayByProfile={todayByProfile}
          multiView={
            multi ? { actingProfileId: scope.actingProfileId } : undefined
          }
        />
        <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
          OD = right eye, OS = left eye.
        </p>
      </div>
    </ProviderOptionsProvider>
  );
}
