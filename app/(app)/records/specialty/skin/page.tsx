import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import SkinSection from "../../SkinSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Skin (#1079). Always renders — the in-page lesion
// form is the only creation path, so it's never gated.
export default async function RecordsSkinPage() {
  const { login, profile } = await requireSession();
  return (
    <PageContainer width="flow" data-testid="records-skin">
      <SectionSubtitle title="Skin">
        Track moles and spots over time.
      </SectionSubtitle>
      <SkinSection
        profileId={profile.id}
        formatPrefs={getDisplayFormatPrefs(login.id)}
      />
    </PageContainer>
  );
}
