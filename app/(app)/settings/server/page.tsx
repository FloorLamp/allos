import {
  getPublicUrl,
  getInstanceTimezone,
  getAiPrefs,
  getBackupSettings,
  getAuditRetentionMonths,
  getSetting,
  getSmtpConfigView,
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
import { getTierConfigView } from "@/lib/settings/ai-tiers";
import { formatBytes } from "@/lib/format-bytes";
import { requireAdmin } from "@/lib/auth";
import { minTrainingAge } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import AppVersion from "@/components/AppVersion";
import SettingsTabs from "../SettingsTabs";
import PublicUrlSettings from "../PublicUrlSettings";
import SmtpSettings from "./SmtpSettings";
import AiSettings from "../AiSettings";
import AiTierSettings from "./AiTierSettings";
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
    <div>
      <PageHeader
        title="Settings"
        subtitle="Server — instance-wide settings that apply to everyone. Only admins can change these."
      />
      <SettingsTabs isAdmin />
      <PublicUrlSettings publicUrl={publicUrl} />
      <SmtpSettings config={getSmtpConfigView()} publicUrl={publicUrl} />
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
                when: new Date(last.mtimeMs).toLocaleString(),
                failed: lastVerification?.integrity === "failed",
              }
            : null
        }
        lastError={getLastBackupError() || null}
        integrity={{
          ok: liveIntegrity.ok,
          at: liveIntegrity.at
            ? new Date(liveIntegrity.at).toLocaleString()
            : null,
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
            return at ? new Date(at).toLocaleString() : null;
          })(),
          lastError: getLastOffsiteError(),
        }}
      />
      <AgeGateSettings minTrainingAge={minTrainingAge()} />
      <AuditRetentionSettings months={getAuditRetentionMonths()} />
      <footer className="mt-10 border-t border-black/10 pt-4 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400">
        Version <AppVersion />
      </footer>
    </div>
  );
}
