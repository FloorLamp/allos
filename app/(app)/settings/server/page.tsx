import {
  getPublicUrl,
  getTelegramBotConfig,
  getInstanceTimezone,
  getAiPrefs,
  getBackupSettings,
} from "@/lib/settings";
import {
  getLastBackup,
  getLastBackupError,
  isOffsiteConfigured,
  getLastOffsiteBackupAt,
  getLastOffsiteError,
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

export const dynamic = "force-dynamic";

export default async function ServerSettingsPage() {
  // Instance-wide settings are admin-only — requireAdmin() redirects a member.
  const { profile } = await requireAdmin();

  const publicUrl = getPublicUrl();
  const last = getLastBackup();

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
              }
            : null
        }
        lastError={getLastBackupError() || null}
        offsite={{
          configured: isOffsiteConfigured(),
          lastAt: (() => {
            const at = getLastOffsiteBackupAt();
            return at ? new Date(at).toLocaleString() : null;
          })(),
          lastError: getLastOffsiteError(),
        }}
      />
      <AgeGateSettings minTrainingAge={minTrainingAge()} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-400 dark:border-white/10 dark:text-slate-500">
        Version <AppVersion />
      </footer>
    </div>
  );
}
