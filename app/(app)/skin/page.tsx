import { requireSession } from "@/lib/auth";
import { getSkinLesions, getSkinLesionFollowUps } from "@/lib/queries";
import { getLesionPhotos } from "@/lib/skin-photo-write";
import { PageHeader } from "@/components/ui";
import SkinLesionForm from "./SkinLesionForm";
import SkinLesionList from "./SkinLesionList";
import { addSkinLesion } from "./actions";

export const dynamic = "force-dynamic";

// Skin: the profile's tracked moles / spots — a body-map location, size, and ABCDE
// observations, with serial dated PHOTOS per lesion so a side-by-side "is this changing?"
// comparison lives in one place, and a "watch, recheck in N months" lesion that seeds a
// tracked follow-up (#700). This is a self-monitoring RECORD, not an assessment — the
// app tracks and compares; any judgment about a lesion is your dermatologist's.
export default async function SkinPage() {
  const { profile } = await requireSession();
  const records = getSkinLesions(profile.id);
  const followUps = getSkinLesionFollowUps(profile.id);
  const photos = getLesionPhotos(profile.id);

  return (
    <div>
      <PageHeader
        title="Skin"
        subtitle="Track moles and spots over time — a body-map location, size, and your ABCDE observations, with dated photos for side-by-side comparison. Flag one to watch and it becomes a tracked recheck."
      />

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
    </div>
  );
}
