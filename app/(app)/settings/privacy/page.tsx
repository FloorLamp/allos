import {
  getMentalHealthShareFull,
  getOfflineSnapshotsEnabled,
  getProfileCrisisResourcesOverride,
} from "@/lib/settings";
import { formatCrisisResourcesText } from "@/lib/crisis-resources";
import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import CrisisResourcesEditor from "@/components/CrisisResourcesEditor";
import SettingsGroupLayout from "../SettingsGroupLayout";
import SettingsAdvanced from "../SettingsAdvanced";
import MentalHealthPrivacyForm from "../profile/MentalHealthPrivacyForm";
import OfflineSnapshotsSettings from "@/components/offline/OfflineSnapshotsSettings";
import { saveProfileCrisisResources } from "../profile/actions";

export const dynamic = "force-dynamic";

// Privacy (#1462) — how much mental-health detail this profile's records share, what is
// kept readable on this device with no network (#2908), plus the niche per-profile
// crisis-resources override behind the Advanced fold (§3): a mixed-region household
// needs it, everyone else inherits the instance default set on Server.
export default async function PrivacySettingsPage() {
  const { login, profile } = await requireSession();
  return (
    <SettingsGroupLayout group="privacy" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <MentalHealthPrivacyForm
          shareFull={getMentalHealthShareFull(profile.id)}
        />
        {/* Offline reads (#2908). Privacy, not Display: the decision it asks about
        is what PHI sits on the device, which is the same question the emergency
        card's own toggle asks on the Passport. */}
        <OfflineSnapshotsSettings
          enabled={getOfflineSnapshotsEnabled(profile.id)}
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
