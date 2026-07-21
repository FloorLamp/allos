import { requireSession } from "@/lib/auth";
import ProvidersSection from "../../ProvidersSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Care › Providers (#1079): the #1055 provider directory — a heavy
// solo pane, never stacked. Content component moved, not rewritten.
export default async function RecordsProvidersPage() {
  const { profile } = await requireSession();
  return (
    <div data-testid="records-providers">
      <SectionSubtitle>
        Your shared registry of clinicians and organizations. Record counts are
        for the active profile.
      </SectionSubtitle>
      <ProvidersSection profileId={profile.id} profileName={profile.name} />
    </div>
  );
}
