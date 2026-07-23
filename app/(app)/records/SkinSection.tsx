import {
  getSkinLesions,
  getSkinLesionFollowUps,
  getPickerProviders,
} from "@/lib/queries";
import { getLesionPhotos } from "@/lib/skin-photo-write";
import { ProviderOptionsProvider } from "@/components/ProviderOptionsContext";
import SkinLesionForm from "@/app/(app)/skin/SkinLesionForm";
import SkinLesionList from "@/app/(app)/skin/SkinLesionList";
import { addSkinLesion } from "@/app/(app)/skin/actions";

// Skin (former /skin index, #1042 final tail): the profile's tracked moles / spots —
// a body-map location, size, and ABCDE observations, with serial dated PHOTOS per
// lesion so a side-by-side "is this changing?" comparison lives in one place, and a
// "watch, recheck in N months" lesion that seeds a tracked follow-up (#700), now the
// #skin section of /records. This is a self-monitoring RECORD, not an assessment —
// the app tracks and compares; any judgment about a lesion is your dermatologist's.
// The skin lesion form here is the ONLY creation path for this domain, so the section
// renders unconditionally (its former nav leaf was ungated). Server Actions + client
// components stayed in app/(app)/skin/; the page body moved here.
export default function SkinSection({ profileId }: { profileId: number }) {
  const records = getSkinLesions(profileId);
  const followUps = getSkinLesionFollowUps(profileId);
  const photos = getLesionPhotos(profileId);

  return (
    <ProviderOptionsProvider providers={getPickerProviders()}>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <SkinLesionList
            items={records}
            followUps={followUps}
            photos={photos}
          />
        </div>

        <div className="min-w-0 space-y-4">
          <SkinLesionForm action={addSkinLesion} />
          <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
            Informational only, not medical advice. This is a self-monitoring
            record for you and your dermatologist — it tracks and compares
            lesions, it does not assess them.
          </p>
        </div>
      </div>
    </ProviderOptionsProvider>
  );
}
