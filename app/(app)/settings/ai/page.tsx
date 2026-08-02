import { getAiPrefs } from "@/lib/settings";
import { getTierConfigView } from "@/lib/settings/ai-tiers";
import { requireAdmin } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import AiTierSettings from "./AiTierSettings";
import AiSettings from "./AiSettings";

export const dynamic = "force-dynamic";

// AI configuration (issue #1870) — a sub-page of the Server group, following the
// account→tokens precedent: the registry entry in lib/settings-groups.ts is what
// puts it in both navigation renderings. The two AI cards (provider tiers #875 +
// the automation knobs #424) moved here from the ten-card Server page; they share
// a topic and an audience but were nearly half that page's scroll.
//
// Same tier, same gate as its parent: instance-wide settings, requireAdmin() —
// the registry's adminOnly flag only hides navigation, never replaces this check.
export default async function AiSettingsPage() {
  const { login, profile } = await requireAdmin();

  return (
    <SettingsGroupLayout group="server" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <AiTierSettings
          heavy={getTierConfigView("heavy")}
          light={getTierConfigView("light")}
        />
        <AiSettings prefs={getAiPrefs()} />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
