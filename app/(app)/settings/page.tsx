import { getUnitPrefs } from "@/lib/settings";
import { requireSession, listLoginSessions } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { getLoginTotpState, countUnusedRecoveryCodes } from "@/lib/two-factor";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import SettingsTabs from "./SettingsTabs";
import UnitPrefsForm from "./UnitPrefsForm";
import ChangePasswordSettings from "./ChangePasswordSettings";
import TwoFactorSettings from "./TwoFactorSettings";
import ActiveSessions from "./ActiveSessions";
import PushNotificationSettings from "./PushNotificationSettings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // In a public demo the read-only demo member can't change its (public,
  // nightly-reset) password — hide the form entirely (#181). Admins keep it.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);
  const prefs = getUnitPrefs(login.id);
  const hideEquipment = isTrainingRestricted(profile.id);
  const sessions = await listLoginSessions(login.id);
  const twofaEnabled = getLoginTotpState(login.id).enabled;
  const recoveryRemaining = twofaEnabled
    ? countUnusedRecoveryCodes(login.id)
    : 0;

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={`Preferences — these settings belong to your login (${login.username}), not the profile being viewed. They follow you across every profile.`}
      />
      <SettingsTabs isAdmin={isAdmin} hideEquipment={hideEquipment} />
      <UnitPrefsForm prefs={prefs} />
      <PushNotificationSettings />
      {!demoRestricted && <ChangePasswordSettings username={login.username} />}
      <TwoFactorSettings
        enabled={twofaEnabled}
        recoveryRemaining={recoveryRemaining}
      />
      <ActiveSessions sessions={sessions} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Version <AppVersion />
      </footer>
    </div>
  );
}
