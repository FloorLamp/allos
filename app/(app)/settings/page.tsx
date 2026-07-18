import { getUnitPrefs, getDisplayFormatPrefs } from "@/lib/settings";
import { requireSession, listLoginSessions } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { getLoginTotpState, countUnusedRecoveryCodes } from "@/lib/two-factor";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import SettingsTabs from "./SettingsTabs";
import UnitPrefsForm from "./UnitPrefsForm";
import FormatPrefsForm from "./FormatPrefsForm";
import ChangePasswordSettings from "./ChangePasswordSettings";
import TwoFactorSettings from "./TwoFactorSettings";
import ActiveSessions from "./ActiveSessions";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // In a public demo the read-only demo member can't change its (public,
  // nightly-reset) password, enroll 2FA, or revoke other visitors' sessions —
  // hide those affordances (#181, #278). The Server Actions refuse server-side
  // too (requireLoginWriteAccess); this trimming is only the convenience layer.
  // Admins keep everything.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);
  const prefs = getUnitPrefs(login.id);
  const formatPrefs = getDisplayFormatPrefs(login.id);
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
      <SettingsTabs isAdmin={isAdmin} />
      <UnitPrefsForm prefs={prefs} />
      <FormatPrefsForm prefs={formatPrefs} />
      {!demoRestricted && <ChangePasswordSettings username={login.username} />}
      {!demoRestricted && (
        <TwoFactorSettings
          enabled={twofaEnabled}
          recoveryRemaining={recoveryRemaining}
        />
      )}
      <ActiveSessions sessions={sessions} canRevoke={!demoRestricted} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        Version <AppVersion />
      </footer>
    </div>
  );
}
