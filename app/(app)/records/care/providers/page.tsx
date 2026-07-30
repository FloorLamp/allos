import { requireSession } from "@/lib/auth";
import ProvidersSection from "../../ProvidersSection";
import { SectionSubtitle } from "../../SectionHeader";
import PageContainer from "@/components/PageContainer";

export const dynamic = "force-dynamic";

// Health record › Care › Providers (#1079): the #1055 provider directory — a heavy
// solo pane, never stacked. Content component moved, not rewritten.
export default async function RecordsProvidersPage() {
  const { profile } = await requireSession();
  return (
    <PageContainer width="flow" data-testid="records-providers">
      <SectionSubtitle title="Providers">
        Review clinicians and care organizations.
      </SectionSubtitle>
      <ProvidersSection profileId={profile.id} profileName={profile.name} />
    </PageContainer>
  );
}
