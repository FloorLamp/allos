import { accessForProfile, requireSession } from "@/lib/auth";
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
        // #4694, riding #5302's adoption. Every other record pane passes what its
        // `scope` already resolved; this pane resolves no scope — it is
        // acting-profile-only by design — so it asks `accessForProfile` directly,
        // which is the same function `resolveScope` fills its map from and the same
        // call the training-event page makes for its own single-profile gate.
        access={accessForProfile(login.id, login.role, profile.id)}
        formatPrefs={getDisplayFormatPrefs(login.id)}
      />
    </PageContainer>
  );
}
