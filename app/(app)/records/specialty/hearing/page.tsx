import { requireSession } from "@/lib/auth";
import HearingSection from "../../HearingSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Specialty › Hearing (#1600) — the pane that sits beside Vision.
//
// UNGATED, unlike Vision/Dental: those two hide when empty because Data → Import is
// also a creation path for them, so an empty section strands nobody. Hearing's in-page
// form is TODAY the only creation path (audiometry import is explicitly a later
// change), so gating it on data would make the first audiogram unreachable — the exact
// stranding the #1079 gate rule warns about. Skin and Mental health are ungated for the
// same reason.
export default async function RecordsHearingPage() {
  const { profile } = await requireSession();
  return (
    <PageContainer width="flow" data-testid="records-hearing">
      <SectionSubtitle title="Hearing">
        Record audiogram thresholds and compare them over time.
      </SectionSubtitle>
      <HearingSection profileId={profile.id} />
    </PageContainer>
  );
}
