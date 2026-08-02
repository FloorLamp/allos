import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import {
  getNavRelevance,
  getRecordsSpecialtyRelevance,
} from "@/lib/queries/nav-relevance";
import { visibleSpecialtyPanes } from "../../nav";
import DentalSection from "../../DentalSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Dental (#1079). DATA-GATED like Vision: the sub-tab
// hides AND this route re-gates server-side — a direct hit with no dental rows
// redirects to the first visible specialty pane.
export default async function RecordsDentalPage() {
  const { profile } = await requireSession();
  // The first VISIBLE pane, from the shared gated list (see the Vision pane's note).
  if (!getNavRelevance(profile.id).dental)
    redirect(
      visibleSpecialtyPanes(getRecordsSpecialtyRelevance(profile.id))[0].href
    );
  return (
    <PageContainer width="flow" data-testid="records-dental">
      <SectionSubtitle title="Dental">
        Review dental procedures and tooth-specific exam findings.
      </SectionSubtitle>
      <DentalSection profileId={profile.id} />
    </PageContainer>
  );
}
