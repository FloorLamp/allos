import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  getNavRelevance,
  getRecordsSpecialtyRelevance,
} from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import VisionSection from "../../VisionSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Vision (#1079). DATA-GATED (getNavRelevance): the
// sub-tab hides AND this route re-gates server-side — a direct hit when the profile
// has no optical rows redirects to the first visible specialty pane (the
// SettingsTabs admin-tab discipline: a hidden tab is an unreachable route). Rows
// also arrive via Data → Import, so hiding the empty section never strands creation.
export default async function RecordsVisionPage() {
  const { login, profile } = await requireSession();
  // Bounce to the FIRST VISIBLE pane, computed from the same gated pane list the
  // sub-tab strip and the bare-group redirect use — never a hard-coded sibling route,
  // which silently rots the moment a pane is added ahead of it (#1600 added Hearing).
  if (!getNavRelevance(profile.id).vision)
    redirect(
      visibleSpecialtyPanes(getRecordsSpecialtyRelevance(profile.id))[0].href
    );
  return (
    <PageContainer width="flow" data-testid="records-vision">
      <SectionSubtitle title="Vision">
        Review eyeglass and contact-lens prescriptions over time.
      </SectionSubtitle>
      <VisionSection profileId={profile.id} loginId={login.id} />
    </PageContainer>
  );
}
