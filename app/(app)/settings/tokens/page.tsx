import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { listAllApiTokens, listApiTokensForLogin } from "@/lib/api-tokens";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import ApiTokensSettings from "../ApiTokensSettings";

export const dynamic = "force-dynamic";

// API tokens (issue #1734) — the login-tier credential registry, a sub-page of the
// Account & security group (the registry entry in lib/settings-groups.ts is what puts
// it in both navigation renderings).
//
// NOT admin-only: a token is a way to present YOUR login, so every member manages
// their own. An ADMIN additionally sees every login's tokens — names, capabilities and
// last-used stamps, never secret material — which is the same visibility they already
// hold over logins and grants, and the only way to notice a stale credential on a
// login someone left behind.
//
// Demo mode (#181/#278) trims the mint/revoke affordances; the actions refuse
// server-side too (requireLoginWriteAccess), so this is only the convenience layer.
export default async function ApiTokensPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  const tokens = isAdmin ? listAllApiTokens() : listApiTokensForLogin(login.id);

  return (
    <SettingsGroupLayout group="account" login={login} profile={profile}>
      <PageContainer width="reading">
        <ApiTokensSettings
          tokens={tokens}
          showOwner={isAdmin}
          canManage={!isDemoRestricted(isDemoMode(), login.role)}
        />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
