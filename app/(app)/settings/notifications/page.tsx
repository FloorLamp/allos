import {
  getProfileTelegram,
  getProfileFoodTelegram,
  getProfileHomeAssistant,
  getTelegramBotConfig,
  getNotifySchedule,
  getUserAge,
  getProfileTelegramDisabledKinds,
  getLoginPushDisabledKinds,
  getPublicUrl,
} from "@/lib/settings";
import { inferWorkoutSchedule } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { getNotifyError } from "@/lib/notifications";
import {
  isPushConfigured,
  countPushSubscriptionsForLogin,
} from "@/lib/notifications/push";
import { isValidWebhookUrl } from "@/lib/notifications/home-assistant-core";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import PushNotificationSettings from "./PushNotificationSettings";
import ProfileNotificationSettings from "./ProfileNotificationSettings";
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

// The Notifications tab (#928): the one place to manage where reminders arrive.
// A presentation-only composition of all three settings tiers — storage stays in
// each tier's store and every Server Action stays in its tier-scoped, uniformly-
// gated module (#319). Sections are labeled by OWNER, preserving the tier subtitles.
// Below the channel sections sits the kind × channel matrix.
export default async function NotificationsSettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // Demo mode (#181): the read-only demo member can't configure Telegram/HA
  // (no bot is configured anyway) or edit the matrix — trim those write affordances.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);

  const telegram = getProfileTelegram(profile.id);
  const bot = getTelegramBotConfig();
  const botConfigured = bot.telegramBotToken !== "";
  const ha = getProfileHomeAssistant(profile.id);
  const publicUrl = getPublicUrl();

  const telegramConfigured =
    botConfigured && telegram.telegramEnabled && telegram.telegramChatId !== "";
  const pushConfigured =
    isPushConfigured() && countPushSubscriptionsForLogin(login.id) > 0;
  const haConfigured = ha.enabled && isValidWebhookUrl(ha.webhookUrl);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Notifications — where reminders arrive. Web Push follows your login; Telegram and Home Assistant follow the profile you’re viewing."
      />
      <SettingsTabs isAdmin={isAdmin} />

      <SectionHeader
        title="This login"
        subtitle="Browser notifications for whoever is signed in — they cover every profile your login can access."
      />
      <PushNotificationSettings />

      {!demoRestricted && (
        <>
          <SectionHeader
            title="This profile"
            subtitle={`Reminders for ${profile.name} — the chat they go to, the schedule, and the Home Assistant webhook.`}
          />
          <ProfileNotificationSettings
            telegram={telegram}
            botConfigured={botConfigured}
            schedule={getNotifySchedule(profile.id)}
            workoutSummary={workoutScheduleSummary(profile.id)}
            foodTelegramEnabled={getProfileFoodTelegram(profile.id)}
            foodLoggingRelevant={isFoodLoggingRelevant(getUserAge(profile.id))}
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
            telegramDisabled={getProfileTelegramDisabledKinds(profile.id)}
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
