import {
  getPublicUrl,
  getInstanceTimezone,
  getAiPrefs,
  getBackupSettings,
  getAuditRetentionMonths,
  getSetting,
  getSmtpConfigView,
  getGlobalCrisisResources,
} from "@/lib/settings";
import { formatCrisisResourcesText } from "@/lib/crisis-resources";
import {
  getLastBackup,
  getLastBackupError,
  isOffsiteConfigured,
  getLastOffsiteBackupAt,
  getLastOffsiteError,
  getOffsiteReadiness,
  readVerification,
} from "@/lib/backup";
import { getTierConfigView } from "@/lib/settings/ai-tiers";
import { formatBytes } from "@/lib/format-bytes";
import { requireAdmin } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { formatTimestamp } from "@/lib/format-date";
import { minTrainingAge } from "@/lib/age-gate";
import AppVersion from "@/components/AppVersion";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import SettingsAdvanced from "../SettingsAdvanced";
import PublicUrlSettings from "../PublicUrlSettings";
import ServerTelegramSettings from "../notifications/ServerTelegramSettings";
import SmtpSettings from "./SmtpSettings";
import AiSettings from "../AiSettings";
import AiTierSettings from "./AiTierSettings";
import InstanceTimezoneSettings from "./InstanceTimezoneSettings";
import AgeGateSettings from "./AgeGateSettings";
import BackupSettings from "./BackupSettings";
import AuditRetentionSettings from "./AuditRetentionSettings";
import CrisisResourcesEditor from "@/components/CrisisResourcesEditor";
import { saveCrisisResources } from "./actions";
import { getTelegramBotConfig } from "@/lib/settings";
import { getNotifyError } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export default async function ServerSettingsPage() {
  // Instance-wide settings are admin-only — requireAdmin() redirects a member.
  const { login, profile } = await requireAdmin();
  // Instance status timestamps join the one admin-ops shape, read as UTC
  // (issue #1448) — the same formatter the Audit / Errors / AI-log tables use.
  const formatPrefs = getDisplayFormatPrefs(login.id);
  const opsStamp = (at: string | number) =>
    `${formatTimestamp(at, formatPrefs, { zone: "utc" })} UTC`;

  const publicUrl = getPublicUrl();
  const last = getLastBackup();
  // Label the newest FILE as failed if its verification sidecar says so, rather
  // than presenting an integrity-failed snapshot (kept for forensics) as "the last
  // backup" (#472).
  const lastVerification = last ? readVerification(last.name) : null;
  const offsiteReadiness = getOffsiteReadiness();
  // Weekly live-DB integrity verdict (#621): "0" = corruption found, "1" = ok,
  // undefined = never run. Surfaced so an admin can see the failure the health
  // endpoint reports AND re-test after repairing the DB (Recheck integrity now).
  const liveIntegrityRaw = getSetting("backup_live_integrity_ok");
  const liveIntegrity = {
    ok: liveIntegrityRaw === undefined ? null : liveIntegrityRaw === "1",
    at: getSetting("backup_live_integrity_at") ?? null,
    detail: getSetting("backup_live_integrity_detail") || null,
  };

  return (
    <SettingsGroupLayout group="server" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <PublicUrlSettings publicUrl={publicUrl} />
        <SmtpSettings config={getSmtpConfigView()} publicUrl={publicUrl} />
        {/* The instance-wide Telegram bot moved here from the Notifications tab
            (#1462 §1/§6): one bot serves every profile, so it is server config —
            the Notifications page now holds only the per-login/per-profile
            channels that ride it. */}
        <ServerTelegramSettings
          config={getTelegramBotConfig()}
          publicUrl={publicUrl}
          lastError={getNotifyError()}
        />
        <AiTierSettings
          heavy={getTierConfigView("heavy")}
          light={getTierConfigView("light")}
        />
        <AiSettings prefs={getAiPrefs()} />
        <InstanceTimezoneSettings timezone={getInstanceTimezone()} />
        <BackupSettings
          settings={getBackupSettings()}
          lastBackup={
            last
              ? {
                  name: last.name,
                  size: formatBytes(last.size),
                  when: opsStamp(last.mtimeMs),
                  failed: lastVerification?.integrity === "failed",
                }
              : null
          }
          lastError={getLastBackupError() || null}
          integrity={{
            ok: liveIntegrity.ok,
            at: liveIntegrity.at ? opsStamp(liveIntegrity.at) : null,
            detail: liveIntegrity.detail,
          }}
          offsite={{
            configured: isOffsiteConfigured(),
            ready: offsiteReadiness.configured ? offsiteReadiness.ready : false,
            notReadyReason: offsiteReadiness.configured
              ? (offsiteReadiness.reason ?? null)
              : null,
            lastAt: (() => {
              const at = getLastOffsiteBackupAt();
              return at ? opsStamp(at) : null;
            })(),
            lastError: getLastOffsiteError(),
          }}
        />
        <CrisisResourcesEditor
          action={saveCrisisResources}
          initialText={formatCrisisResourcesText(getGlobalCrisisResources())}
          title="Crisis resources"
          description="Your region’s crisis line(s), shown on the Crisis support page and inline where a crisis trigger fires."
          testid="crisis-resources-server"
        />
        {/* One-time instance setup lives behind the Advanced fold (#1462 §3) so
            the cards an admin actually revisits stay above it. */}
        <SettingsAdvanced
          testId="server-advanced"
          hint="age gate, audit retention"
        >
          <AgeGateSettings minTrainingAge={minTrainingAge()} />
          <AuditRetentionSettings months={getAuditRetentionMonths()} />
        </SettingsAdvanced>
        <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
          Version <AppVersion />
        </footer>
      </PageContainer>
    </SettingsGroupLayout>
  );
}
