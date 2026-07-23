import { getDisplayFormatPrefs } from "@/lib/settings";
import {
  getOpticalPrescriptions,
  getPickerProviders,
  createVisitOffers,
} from "@/lib/queries";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import CreateVisitFromRecord from "@/components/visit-links/CreateVisitFromRecord";
import { today } from "@/lib/db";
import OpticalPrescriptionForm from "@/app/(app)/vision/OpticalPrescriptionForm";
import OpticalPrescriptionList from "@/app/(app)/vision/OpticalPrescriptionList";
import OpticalProgression from "@/app/(app)/vision/OpticalProgression";
import { addOpticalPrescription } from "@/app/(app)/vision/actions";

// Vision / eye care (former /vision index, #1042 final tail): the profile's
// structured optical (eyeglass/contact) prescriptions — per-eye
// sphere/cylinder/axis/add, PD, and the contacts extras — newest issued first,
// with a per-eye sphere-over-time progression (the "is my myopia getting worse?"
// view), now the data-gated #vision section of /records. Captured from an uploaded
// Rx slip / eye-exam report via AI extraction (Data → Import), or added manually.
// The recurring eye-exam reminder lives on the existing vision_exam preventive
// rule, not duplicated here (#697). Server Actions + client components stayed in
// their route-independent module (app/(app)/vision/); the page body moved here.
export default function VisionSection({
  profileId,
  loginId,
}: {
  profileId: number;
  loginId: number;
}) {
  const prescriptions = getOpticalPrescriptions(profileId);
  // "Create a visit from this record?" (#1099): Rx dated D with no encounter that day.
  const createVisitOffersList = createVisitOffers(profileId, "optical");

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <CreateVisitFromRecord
            profileId={profileId}
            offers={createVisitOffersList}
          />
          <OpticalProgression
            items={prescriptions}
            formatPrefs={getDisplayFormatPrefs(loginId)}
          />
          <OpticalPrescriptionList
            items={prescriptions}
            today={today(profileId)}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <OpticalPrescriptionForm action={addOpticalPrescription} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. OD = right eye, OS = left
            eye.
          </p>
        </div>
      </div>
    </ProviderOptionsProvider>
  );
}
