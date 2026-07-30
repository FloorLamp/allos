import { requireSession } from "@/lib/auth";
import SkinSection from "../../SkinSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Specialty › Skin (#1079). Always renders — the in-page lesion
// form is the only creation path, so it's never gated.
export default async function RecordsSkinPage() {
  const { profile } = await requireSession();
  return (
    <div data-testid="records-skin">
      <SectionSubtitle more="Each record can include a body-map location, size, ABCDE observations, dated photos, and a tracked recheck.">
        Track moles and spots over time.
      </SectionSubtitle>
      <SkinSection profileId={profile.id} />
    </div>
  );
}
