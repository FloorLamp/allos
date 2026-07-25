import {
  getMentalHealthShareFull,
  getProfileCrisisResourcesOverride,
} from "@/lib/settings";
import { formatCrisisResourcesText } from "@/lib/crisis-resources";
import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import CrisisResourcesEditor from "@/components/CrisisResourcesEditor";
import SettingsGroupLayout from "../SettingsGroupLayout";
import SettingsAdvanced from "../SettingsAdvanced";
import MentalHealthPrivacyForm from "../profile/MentalHealthPrivacyForm";
import { saveProfileCrisisResources } from "../profile/actions";

export const dynamic = "force-dynamic";

// Privacy (#1462) — how much mental-health detail this profile's records share, plus
// the niche per-profile crisis-resources override behind the Advanced fold (§3): a
// mixed-region household needs it, everyone else inherits the instance default set on
// Server.
export default async function PrivacySettingsPage() {
  const { login, profile } = await requireSession();
  return (
    <SettingsGroupLayout group="privacy" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <MentalHealthPrivacyForm
          shareFull={getMentalHealthShareFull(profile.id)}
        />
        <SettingsAdvanced
          testId="privacy-advanced"
          hint="crisis-resources override"
        >
          <CrisisResourcesEditor
            action={saveProfileCrisisResources}
            initialText={formatCrisisResourcesText(
              getProfileCrisisResourcesOverride(profile.id) ?? []
            )}
            title="Crisis resources (override)"
            description="Optional per-profile override for a mixed-region household — leave empty to use the instance default."
            testid="crisis-resources-profile"
          />
        </SettingsAdvanced>
      </PageContainer>
    </SettingsGroupLayout>
  );
}
