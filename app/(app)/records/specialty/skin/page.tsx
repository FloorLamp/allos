import { accessForProfile, requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import SkinSection from "../../SkinSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Skin (#1079). NOT DATA-GATED, unlike the Vision and
// Dental panes beside it: they hide and redirect when the view set has no rows, and
// this one cannot, because the in-page lesion form is the only way a first lesion is
// ever created — a pane that appeared only once you had a lesion could never be used
// to record one. So the ROUTE always renders.
//
// THE ADD DOOR IS A SEPARATE QUESTION AND IT IS GATED (#4694, riding #5302's
// adoption). Always-renders is about which profiles can reach the page, not about who
// may write on it: a read-only viewer reaches the pane, reads it, and is offered no
// add door, instead of filling the form in and being bounced by
// `requireWriteAccess()` with their typing lost. The authorization itself is
// unchanged — every action here still opens with that call — and this only stops the
// app promising a write it will refuse.
export default async function RecordsSkinPage() {
  const { login, profile } = await requireSession();
  return (
    <PageContainer width="flow" data-testid="records-skin">
      <SectionSubtitle title="Skin">
        Track moles and spots over time.
      </SectionSubtitle>
      <SkinSection
        profileId={profile.id}
        // #4694, riding #5302's adoption. A pane holding a `ProfileScope` passes what
        // that already resolved; this one is SINGLE-PROFILE — lib/scope.ts reserves
        // `requireSession()` for exactly that case — so it asks `accessForProfile`
        // directly, which is the same function `resolveScope` fills its own map with
        // and the same call the training-event page makes for its single-profile
        // gate. The full argument, and why this route is allowed rather than an
        // oversight, is on `AddEntryPanel`'s `access` prop.
        access={accessForProfile(login.id, login.role, profile.id)}
        formatPrefs={getDisplayFormatPrefs(login.id)}
      />
    </PageContainer>
  );
}
