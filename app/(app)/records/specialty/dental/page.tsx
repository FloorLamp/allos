import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import DentalSection from "../../DentalSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Dental (#1079). DATA-GATED like Vision: the sub-tab
// hides AND this route re-gates server-side — a direct hit with no dental rows
// redirects to the first visible specialty pane.
export default async function RecordsDentalPage() {
  const { profile } = await requireSession();
  if (!getNavRelevance(profile.id).dental) redirect("/records/specialty/skin");
  return (
    <PageContainer width="flow" data-testid="records-dental">
      <SectionSubtitle
        title="Dental"
        more="Add records manually or import them; periodontal measurements and dental X-rays live on Results."
      >
        Review dental procedures and tooth-specific exam findings.
      </SectionSubtitle>
      <DentalSection profileId={profile.id} />
    </PageContainer>
  );
}
