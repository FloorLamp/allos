import { redirect } from "next/navigation";
import { requireScope } from "@/lib/scope";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import VisionSection from "../../VisionSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Vision (#1079). DATA-GATED: the sub-tab hides AND this
// route re-gates server-side — a direct hit when nobody in view has optical rows
// redirects to the first visible specialty pane (the SettingsTabs admin-tab
// discipline: a hidden tab is an unreachable route). Rows also arrive via
// Data → Import, so hiding the empty section never strands creation.
//
// MULTI-VIEW since #2557, on the Dental pane's reasoning: the gate asks the VIEW SET
// because the pane lists it, and authorization stays per item at the write actions.
export default async function RecordsVisionPage() {
  const scope = await requireScope();
  const relevance = getRecordsSpecialtyRelevanceForView(
    scope.actingProfileId,
    scope.viewIds
  );
  // Bounce to the FIRST VISIBLE pane, computed from the same gated pane list the
  // sub-tab strip and the bare-group redirect use — never a hard-coded sibling route,
  // which silently rots the moment a pane is added ahead of it (#1600 added Hearing).
  if (!relevance.vision) redirect(visibleSpecialtyPanes(relevance)[0].href);
  return (
    <PageContainer width="flow" data-testid="records-vision">
      <SectionSubtitle title="Vision">
        Review eyeglass and contact-lens prescriptions over time.
      </SectionSubtitle>
      <VisionSection scope={scope} />
    </PageContainer>
  );
}
