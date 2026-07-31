import {
  requireSession,
  listLoginSessions,
  getAccessibleProfiles,
  ownProfileForLogin,
} from "@/lib/auth";
import { disambiguateProfileNames } from "@/lib/profile-disambiguation";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { getLoginTotpState, countUnusedRecoveryCodes } from "@/lib/two-factor";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import OwnProfileForm from "../OwnProfileForm";
import ChangePasswordSettings from "../ChangePasswordSettings";
import TwoFactorSettings from "../TwoFactorSettings";
import ActiveSessions from "../ActiveSessions";

export const dynamic = "force-dynamic";

// Account & security (#1462) — the login-tier group: who you are to the app, how you
// prove it, and where you're signed in. Ordered daily-revisited last-to-first per §3:
// the own-profile association and password/2FA are set-and-forget, the sessions list
// is the one you come back to.
export default async function AccountSettingsPage() {
  const { login, profile } = await requireSession();
  // Demo mode (#181, #278): the shared read-only demo login can't change its
  // (public, nightly-reset) password, enroll 2FA, or revoke other visitors'
  // sessions. The Server Actions refuse server-side too
  // (requireLoginWriteAccess) — this trimming is only the convenience layer.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);

  // Own-profile association (#1013): the login's accessible profiles
  // (disambiguated, #534) populate the "which one is you?" picker.
  const accessibleProfiles = await getAccessibleProfiles();
  const ownProfileNames = disambiguateProfileNames(accessibleProfiles);
  const ownProfileChoices = accessibleProfiles.map((p) => ({
    ...p,
    name: ownProfileNames.get(p.id) ?? p.name,
  }));
  const ownProfileId = ownProfileForLogin(login.id);
  const sessions = await listLoginSessions(login.id);
  const twofaEnabled = getLoginTotpState(login.id).enabled;
  const recoveryRemaining = twofaEnabled
    ? countUnusedRecoveryCodes(login.id)
    : 0;

  return (
    <SettingsGroupLayout group="account" login={login} profile={profile}>
      {/* Form cards keep the compact `form` measure; the sessions LIST gets a
          reading measure of its own so device labels and timestamps stop
          truncating in a 520px column (#1451.B). */}
      <PageContainer width="form" className="space-y-6">
        {ownProfileChoices.length > 0 && (
          <OwnProfileForm
            profiles={ownProfileChoices}
            ownProfileId={ownProfileId}
          />
        )}
        {!demoRestricted && (
          <ChangePasswordSettings username={login.username} />
        )}
        {!demoRestricted && (
          <TwoFactorSettings
            enabled={twofaEnabled}
            recoveryRemaining={recoveryRemaining}
          />
        )}
      </PageContainer>
      <PageContainer width="reading" className="mt-6">
        <ActiveSessions sessions={sessions} canRevoke={!demoRestricted} />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
