import { getUnitPrefs } from "@/lib/settings";
import { requireSession, listLoginSessions } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import SettingsTabs from "./SettingsTabs";
import UnitPrefsForm from "./UnitPrefsForm";
import ChangePasswordSettings from "./ChangePasswordSettings";
import ActiveSessions from "./ActiveSessions";
import PushNotificationSettings from "./PushNotificationSettings";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const { login, profile } = requireSession();
  const isAdmin = login.role === "admin";
  const prefs = getUnitPrefs(login.id);
  const hideEquipment = isTrainingRestricted(profile.id);
  const sessions = listLoginSessions(login.id);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={`Preferences — these settings belong to your login (${login.username}), not the profile being viewed. They follow you across every profile.`}
      />
      <SettingsTabs isAdmin={isAdmin} hideEquipment={hideEquipment} />
      <UnitPrefsForm prefs={prefs} />
      <PushNotificationSettings />
      <ChangePasswordSettings username={login.username} />
      <ActiveSessions sessions={sessions} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Version <AppVersion />
      </footer>
    </div>
  );
}
