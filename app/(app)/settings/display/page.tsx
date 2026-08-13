import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import AppearancePicker from "@/components/AppearancePicker";
import SettingsGroupLayout from "../SettingsGroupLayout";
import UnitPrefsForm from "../UnitPrefsForm";
import FormatPrefsForm from "../FormatPrefsForm";

export const dynamic = "force-dynamic";

// Display & units (#1462) — the other login-tier group: how values are RENDERED for
// whoever is signed in. Storage stays canonical (kilograms/kilometers) no matter what
// is picked here; these prefs are read at the display boundary only.
export default async function DisplaySettingsPage() {
  const { login, profile } = await requireSession();
  return (
    <SettingsGroupLayout group="display" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        {/* Device-scoped (#2701): the palette lives beside the theme choice in
            this browser's storage, not in login settings. */}
        <AppearancePicker />
        <UnitPrefsForm prefs={getUnitPrefs(login.id)} />
        <FormatPrefsForm prefs={getDisplayFormatPrefs(login.id)} />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
