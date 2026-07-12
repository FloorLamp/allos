"use server";
// Admin/global settings actions — the Server tab (Settings → Server). Split out
// of app/(app)/settings/actions.ts by auth tier (#319): every action here gates
// on requireAdmin(), so the auth boundary is visible in the file layout, not just
// in each function body. Re-exported from ../actions for back-compat import paths.
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import {
  setAiPrefs,
  setPublicUrl,
  isValidTimezone,
  setInstanceTimezone,
  getBackupSettings,
  setBackupSettings,
  setAuditRetentionMonths,
  getTelegramBotConfig,
  setTelegramBotConfig,
  getPublicUrl,
} from "@/lib/settings";
import { performBackup, initOffsiteDestination } from "@/lib/backup";
import { formatBytes } from "@/lib/format-bytes";
import { setMinTrainingAge } from "@/lib/age-gate";
import { normalizePublicUrl } from "@/lib/public-url";
import { setWebhook, deleteWebhook } from "@/lib/notifications/telegram";
import { createLogger } from "@/lib/log";

const log = createLogger("settings");

// ---- AI (global, admin-only) ----

export async function saveAiSettings(formData: FormData) {
  await requireAdmin();
  // Accept both the "1" our client sends and a native checkbox's "on".
  const on = (key: string) => {
    const v = formData.get(key);
    return v === "1" || v === "on";
  };
  // The clamp is applied inside setAiPrefs (pure clampMaxRunsPerDay), so a blank/
  // bad value falls back to the default 1 rather than disabling the backstop.
  setAiPrefs({
    autoSupplementSuggestions: on("auto_supplement_suggestions"),
    recommendationMaxRunsPerDay: Number(
      formData.get("recommendation_max_runs_per_day")
    ),
  });
  revalidatePath("/settings/server");
}

// ---- Public URL (global, admin-only) ----
// Shared by Telegram webhook, Strava OAuth, Health Connect.

export async function savePublicUrl(
  formData: FormData
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  await requireAdmin();
  const res = normalizePublicUrl(String(formData.get("public_url") ?? ""));
  if (!res.ok) return res;
  setPublicUrl(res.url);
  revalidatePath("/settings/server");
  revalidatePath("/data", "layout");
  return res;
}

// ---- Instance-default timezone (global, admin-only) ----
// Seeds new profiles and backstops any profile without its own timezone.

export async function saveInstanceTimezone(formData: FormData) {
  await requireAdmin();
  const tz = String(formData.get("timezone") ?? "").trim();
  if (tz && isValidTimezone(tz)) setInstanceTimezone(tz);
  revalidatePath("/settings/server");
}

// ---- Automated backups (global, admin-only) ----
// Nightly SQLite snapshot config + on-demand snapshot. See lib/backup.ts.

export async function saveBackupSettings(formData: FormData) {
  await requireAdmin();
  const on = (key: string) => {
    const v = formData.get(key);
    return v === "1" || v === "on";
  };
  const num = (key: string, fallback: number) => {
    const n = Number(formData.get(key));
    return Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  const prev = getBackupSettings();
  setBackupSettings({
    enabled: on("backup_enabled"),
    hour: (() => {
      const h = num("backup_hour", prev.hour);
      return h >= 0 && h <= 23 ? h : prev.hour;
    })(),
    keepDaily: num("backup_keep_daily", prev.keepDaily),
    keepWeekly: num("backup_keep_weekly", prev.keepWeekly),
  });
  revalidatePath("/settings/server");
}

// On-demand snapshot. Surfaces the created file (name + size) or the failure —
// e.g. a full disk — rather than failing silently.
export async function backupNow(): Promise<{
  ok: boolean;
  message: string;
}> {
  await requireAdmin();
  try {
    const { name, size, verification } = performBackup();
    revalidatePath("/settings/server");
    if (verification.integrity !== "ok") {
      // The snapshot wrote but failed PRAGMA integrity_check — don't report it as
      // a clean backup (performBackup already recorded the error and kept older
      // good snapshots).
      return {
        ok: false,
        message: `Backup ${name} failed integrity check: ${verification.detail ?? "corrupt snapshot"}.`,
      };
    }
    return {
      ok: true,
      message: `Backup created and verified: ${name} (${formatBytes(size)}).`,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// Verify + initialize the off-volume backup destination (#463): write the sentinel
// into the mounted BACKUP_DEST_DIR so replication is allowed. Requires the volume
// to already be mounted (the root must pre-exist) — we never create the root.
export async function verifyOffsiteDestination(): Promise<{
  ok: boolean;
  message: string;
}> {
  await requireAdmin();
  const result = initOffsiteDestination();
  revalidatePath("/settings/server");
  return result;
}

// ---- Audit-log retention (global, admin-only) ----
// The window (whole months) the hourly notify tick keeps `audit_events` for before
// pruning older rows (#98). setAuditRetentionMonths clamps to the allowed range.

export async function saveAuditRetention(formData: FormData) {
  await requireAdmin();
  const raw = String(formData.get("audit_retention_months") ?? "").trim();
  setAuditRetentionMonths(Number(raw));
  revalidatePath("/settings/server");
}

// ---- Fitness age gate (global, admin-only) ----
// The minimum age (whole years) a profile must be to see Training and AI
// Insights surfaces + the Equipment tab. Empty / non-positive clears it
// (gate off). Setting it changes nav/tabs/pages for every profile, so the whole
// app layout is revalidated. See lib/age-gate.ts.

export async function saveMinTrainingAge(formData: FormData) {
  await requireAdmin();
  const raw = String(formData.get("min_training_age") ?? "").trim();
  setMinTrainingAge(raw === "" ? null : Number(raw));
  revalidatePath("/", "layout");
  revalidatePath("/settings/server");
}

// ---- Notifications: global bot credentials (global, admin-only) ----

// The bot token and inbound transport mode are app-wide (a single bot serves
// every profile), so only an admin may change them.
export async function saveTelegramBotConfig(formData: FormData) {
  await requireAdmin();
  const prevMode = getTelegramBotConfig().telegramMode;
  const cfg = setTelegramBotConfig({
    telegramBotToken: String(formData.get("telegram_bot_token") ?? ""),
    telegramMode:
      formData.get("telegram_mode") === "webhook" ? "webhook" : "poll",
  });
  // Switching to polling: drop any registered webhook, since Telegram rejects
  // getUpdates while one is set. Best-effort — the poller reports 409s anyway.
  if (
    prevMode === "webhook" &&
    cfg.telegramMode === "poll" &&
    cfg.telegramBotToken
  ) {
    try {
      await deleteWebhook();
    } catch (e) {
      log.warn("deleteWebhook on mode switch failed", {
        err: e instanceof Error ? e.message : String(e),
      });
    }
  }
  revalidatePath("/settings/server");
}

export async function registerTelegramWebhook(): Promise<{
  ok: boolean;
  message: string;
}> {
  await requireAdmin();
  const cfg = getTelegramBotConfig();
  if (!cfg.telegramBotToken)
    return { ok: false, message: "Save your bot token first." };
  if (!cfg.telegramWebhookSecret)
    return {
      ok: false,
      message: "Save settings first to generate a webhook secret.",
    };
  const url = getPublicUrl();
  if (!url)
    return {
      ok: false,
      message: "Set the public app URL (in the card above) first.",
    };
  try {
    await setWebhook(`${url}/api/telegram/webhook`, cfg.telegramWebhookSecret);
    return { ok: true, message: "Webhook registered ✅" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
