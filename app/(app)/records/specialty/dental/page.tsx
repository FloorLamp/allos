import { redirect } from "next/navigation";
import { requireScope } from "@/lib/scope";
import { getRecordsSpecialtyRelevanceForView } from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import DentalSection from "../../DentalSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Dental (#1079). DATA-GATED like Vision: the sub-tab
// hides AND this route re-gates server-side — a direct hit with no dental rows
// redirects to the first visible specialty pane.
//
// MULTI-VIEW since #2557: the scope resolves ONCE here and travels down as data,
// which is also what makes the gate honest. The pane lists every profile in view, so
// its data gate asks the whole view set ("any member in view has dental rows") rather
// than the acting profile alone — gating on the actor would bounce a caregiver away
// from a pane that was about to list their child's dental work. The product decision,
// and the reason `substanceUse` is deliberately NOT folded the same way, are recorded
// on `specialtyRelevanceForView` (lib/nav-relevance.ts). Note the gate is a
// VISIBILITY decision only: authorization is still per item, at each write action.
export default async function RecordsDentalPage() {
  const scope = await requireScope();
  const relevance = getRecordsSpecialtyRelevanceForView(
    scope.actingProfileId,
    scope.viewIds
  );
  // The first VISIBLE pane, from the shared gated list (see the Vision pane's note).
  if (!relevance.dental) redirect(visibleSpecialtyPanes(relevance)[0].href);
  return (
    <PageContainer width="flow" data-testid="records-dental">
      <SectionSubtitle title="Dental">
        Review dental procedures and tooth-specific exam findings.
      </SectionSubtitle>
      <DentalSection scope={scope} />
    </PageContainer>
  );
}
