import {
  getUnitPrefs,
  getDisplayFormatPrefs,
  getWhatsNewSeenDate,
} from "@/lib/settings";
import {
  hasUnseenNotes,
  loadReleaseNotes,
  newestNoteDate,
} from "@/lib/release-notes";
import {
  requireSession,
  listLoginSessions,
  getAccessibleProfiles,
  ownProfileForLogin,
} from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { getLoginTotpState, countUnusedRecoveryCodes } from "@/lib/two-factor";
import Link from "next/link";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import WhatsNewLink from "@/components/WhatsNewLink";
import SettingsTabs from "./SettingsTabs";
import UnitPrefsForm from "./UnitPrefsForm";
import OwnProfileForm from "./OwnProfileForm";
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
  // Own-profile association (#1013): the login's accessible profiles (disambiguated,
  // #534) populate the "which one is you?" picker; the stored id preselects it.
  const accessibleProfiles = await getAccessibleProfiles();
  const ownProfileNames = disambiguateProfileNames(accessibleProfiles);
  const ownProfileChoices = accessibleProfiles.map((p) => ({
    ...p,
    name: ownProfileNames.get(p.id) ?? p.name,
  }));
  const ownProfileId = ownProfileForLogin(login.id);
  const sessions = await listLoginSessions(login.id);
  const twofaEnabled = getLoginTotpState(login.id).enabled;
  // Same ONE unread comparison the app shell uses for the sidebar dot (#1421).
  const whatsNewUnseen = hasUnseenNotes(
    newestNoteDate(loadReleaseNotes()),
    getWhatsNewSeenDate(login.id)
  );
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
      {ownProfileChoices.length > 0 && (
        <OwnProfileForm
          profiles={ownProfileChoices}
          ownProfileId={ownProfileId}
        />
      )}
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
      <footer className="mt-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-black/10 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        <span>
          Version <AppVersion />
        </span>
        <span aria-hidden>·</span>
        {/* The bundled release notes sit right next to the version they describe
        (issue #1421); the dot is the same login-scoped unread verdict the sidebar
        footer shows, and opening the page clears it. */}
        <WhatsNewLink unseen={whatsNewUnseen} />
        <span aria-hidden>·</span>
        <Link
          href="/disclaimer"
          className="underline-offset-2 hover:text-slate-700 hover:underline dark:hover:text-slate-200"
        >
          Disclaimer
        </Link>
      </footer>
    </div>
  );
}
