import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import DentalSection from "../../DentalSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Specialty › Dental (#1079). DATA-GATED like Vision: the sub-tab
// hides AND this route re-gates server-side — a direct hit with no dental rows
// redirects to the first visible specialty pane.
export default async function RecordsDentalPage() {
  const { profile } = await requireSession();
  if (!getNavRelevance(profile.id).dental) redirect("/records/specialty/skin");
  return (
    <div data-testid="records-dental">
      <SectionSubtitle>
        Your dental procedures and exam findings, anchored to teeth. Add them
        manually or import a dental record. Periodontal measurements (pocket
        depth, bleeding) and dental X-rays live on Results.
      </SectionSubtitle>
      <DentalSection profileId={profile.id} />
    </div>
  );
}
