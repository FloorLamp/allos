import {
  getLoginTelegram,
  getProfileFoodTelegram,
  getProfileMoodCheckin,
  getProfileMoodRecap,
  getProfileSleepDigest,
  getProfileHomeAssistant,
  getTelegramBotConfig,
  getNotifySchedule,
  getUserAge,
  getLoginTelegramDisabledKinds,
  getLoginPushDisabledKinds,
  getNotifyReviewNeeded,
  isProfileMutedForLogin,
  getPublicUrl,
} from "@/lib/settings";
import { inferWorkoutSchedule, typicalWakeTime } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getNotifyError } from "@/lib/notifications";
import {
  isPushConfigured,
  countPushSubscriptionsForLogin,
} from "@/lib/notifications/push";
import { resolveTelegramRecipients } from "@/lib/notifications/fan-out";
import { isValidWebhookUrl } from "@/lib/notifications/home-assistant-core";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import PushNotificationSettings from "./PushNotificationSettings";
import LoginTelegramSettings from "./LoginTelegramSettings";
import ProfileNotificationSettings from "./ProfileNotificationSettings";
import ProfileMuteToggle from "./ProfileMuteToggle";
import HomeAssistantNotificationSettings from "./HomeAssistantNotificationSettings";
import ServerTelegramSettings from "./ServerTelegramSettings";
import NotificationMatrix from "./NotificationMatrix";

export const dynamic = "force-dynamic";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function workoutScheduleSummary(profileId: number): string {
  const { weekdays, hour } = inferWorkoutSchedule(profileId);
  const at = `${String(hour).padStart(2, "0")}:00`;
  if (weekdays.length === 7) return `daily ~${at}`;
  if (weekdays.length === 0) return `~${at}`;
  return `${weekdays.map((d) => WD[d]).join(", ")} ~${at}`;
}

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mt-8 first:mt-0">
      <h2 className="section-label">{title}</h2>
      <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
    </div>
  );
}

// The Notifications tab (#928, re-homed by #1072): the one place to manage where
// reminders arrive. A presentation-only composition of all three settings tiers —
// storage stays in each tier's store and every Server Action stays in its
// tier-scoped, uniformly-gated module (#319). Channels now belong to the LOGIN
// (#1072): the Telegram chat and Web Push both follow whoever is signed in and cover
// every profile they manage; the profile section holds only per-subject content
// (schedule, food/mood/sleep) and the per-login mute for THIS profile.
export default async function NotificationsSettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // Demo mode (#181): the read-only demo member can't configure Telegram/HA
  // (no bot is configured anyway) or edit the matrix — trim those write affordances.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);

  const telegram = getLoginTelegram(login.id);
  const bot = getTelegramBotConfig();
  const botConfigured = bot.telegramBotToken !== "";
  const ha = getProfileHomeAssistant(profile.id);
  const publicUrl = getPublicUrl();

  // The Telegram column is deliverable for THIS profile when at least one managing
  // login (deduped by chat) has an enabled chat — the login-scoped fan-out (#1072).
  const telegramConfigured =
    botConfigured && resolveTelegramRecipients(profile.id).length > 0;
  const pushConfigured =
    isPushConfigured() && countPushSubscriptionsForLogin(login.id) > 0;
  const haConfigured = ha.enabled && isValidWebhookUrl(ha.webhookUrl);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Notifications — where reminders arrive. Your Telegram chat and Web Push follow your login and cover every profile you manage; the schedule follows each profile."
      />
      <SettingsTabs isAdmin={isAdmin} />

      <SectionHeader
        title="This login"
        subtitle="Your channels — the Telegram chat and browsers for whoever is signed in. They cover every profile your login can access."
      />
      <LoginTelegramSettings
        telegram={telegram}
        botConfigured={botConfigured}
        reviewNeeded={getNotifyReviewNeeded(login.id)}
      />
      <PushNotificationSettings />

      {!demoRestricted && (
        <>
          <SectionHeader
            title="This profile"
            subtitle={`Reminders for ${profile.name} — the schedule, per-subject nudges, and the Home Assistant webhook.`}
          />
          <ProfileNotificationSettings
            schedule={getNotifySchedule(profile.id)}
            workoutSummary={workoutScheduleSummary(profile.id)}
            foodTelegramEnabled={getProfileFoodTelegram(profile.id)}
            foodLoggingRelevant={isFoodLoggingRelevant(getUserAge(profile.id))}
            moodCheckinEnabled={getProfileMoodCheckin(profile.id)}
            moodRecapEnabled={getProfileMoodRecap(profile.id)}
            sleepDigestEnabled={getProfileSleepDigest(profile.id)}
            wakeHour={(() => {
              // What "Auto" resolves to (#1117): the profile's typical wake hour,
              // or null when there isn't enough sleep data yet.
              const m = typicalWakeTime(profile.id);
              return m == null ? null : Math.min(23, Math.round(m / 60));
            })()}
          />
          <ProfileMuteToggle
            profileId={profile.id}
            profileName={profile.name}
            muted={isProfileMutedForLogin(login.id, profile.id)}
          />
          <HomeAssistantNotificationSettings config={ha} />
        </>
      )}

      {isAdmin && (
        <>
          <SectionHeader
            title="Server"
            subtitle="Instance-wide Telegram bot — one bot serves every profile. Admin only."
          />
          <ServerTelegramSettings
            config={bot}
            publicUrl={publicUrl}
            lastError={getNotifyError()}
          />
        </>
      )}

      {!demoRestricted && (
        <>
          <SectionHeader
            title="Matrix"
            subtitle="Which kinds reach which channel."
          />
          <NotificationMatrix
            telegramDisabled={getLoginTelegramDisabledKinds(login.id)}
            pushDisabled={getLoginPushDisabledKinds(login.id)}
            haDisabled={ha.disabledKinds}
            telegramConfigured={telegramConfigured}
            pushConfigured={pushConfigured}
            haConfigured={haConfigured}
          />
        </>
      )}
    </div>
  );
}
