import {
  getPublicUrl,
  getTelegramBotConfig,
  getInstanceTimezone,
  getAiPrefs,
  getBackupSettings,
  getAuditRetentionMonths,
} from "@/lib/settings";
import {
  getLastBackup,
  getLastBackupError,
  isOffsiteConfigured,
  getLastOffsiteBackupAt,
  getLastOffsiteError,
  getOffsiteReadiness,
  readVerification,
} from "@/lib/backup";
import { getNotifyError } from "@/lib/notifications";
import { aiEndpointInfo } from "@/lib/ai-client";
import { formatBytes } from "@/lib/format-bytes";
import { requireAdmin } from "@/lib/auth";
import { isTrainingRestricted, minTrainingAge } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import SettingsTabs from "../SettingsTabs";
import PublicUrlSettings from "../PublicUrlSettings";
import AiSettings from "../AiSettings";
import ServerTelegramSettings from "./ServerTelegramSettings";
import InstanceTimezoneSettings from "./InstanceTimezoneSettings";
import AgeGateSettings from "./AgeGateSettings";
import BackupSettings from "./BackupSettings";
import AuditRetentionSettings from "./AuditRetentionSettings";

export const dynamic = "force-dynamic";

export default async function ServerSettingsPage() {
  // Instance-wide settings are admin-only — requireAdmin() redirects a member.
  const { profile } = await requireAdmin();

  const publicUrl = getPublicUrl();
  const last = getLastBackup();
  // Label the newest FILE as failed if its verification sidecar says so, rather
  // than presenting an integrity-failed snapshot (kept for forensics) as "the last
  // backup" (#472).
  const lastVerification = last ? readVerification(last.name) : null;
  const offsiteReadiness = getOffsiteReadiness();

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Server — instance-wide settings that apply to everyone. Only admins can change these."
      />
      <SettingsTabs isAdmin hideEquipment={isTrainingRestricted(profile.id)} />
      <PublicUrlSettings publicUrl={publicUrl} />
      <ServerTelegramSettings
        config={getTelegramBotConfig()}
        publicUrl={publicUrl}
        lastError={getNotifyError()}
      />
      <AiSettings prefs={getAiPrefs()} endpoint={aiEndpointInfo()} />
      <InstanceTimezoneSettings timezone={getInstanceTimezone()} />
      <BackupSettings
        settings={getBackupSettings()}
        lastBackup={
          last
            ? {
                name: last.name,
                size: formatBytes(last.size),
                when: new Date(last.mtimeMs).toLocaleString(),
                failed: lastVerification?.integrity === "failed",
              }
            : null
        }
        lastError={getLastBackupError() || null}
        offsite={{
          configured: isOffsiteConfigured(),
          ready: offsiteReadiness.configured ? offsiteReadiness.ready : false,
          notReadyReason: offsiteReadiness.configured
            ? (offsiteReadiness.reason ?? null)
            : null,
          lastAt: (() => {
            const at = getLastOffsiteBackupAt();
            return at ? new Date(at).toLocaleString() : null;
          })(),
          lastError: getLastOffsiteError(),
        }}
      />
      <AgeGateSettings minTrainingAge={minTrainingAge()} />
      <AuditRetentionSettings months={getAuditRetentionMonths()} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Version <AppVersion />
      </footer>
    </div>
  );
}
