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
  getProfileHouseholdRound,
} from "@/lib/settings";
import { inferWorkoutSchedule, typicalWakeTime } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import {
  isPushConfigured,
  countPushSubscriptionsForLogin,
} from "@/lib/notifications/push";
import {
  resolveTelegramRecipients,
  wouldMuteSilenceSafety,
} from "@/lib/notifications/fan-out";
import { isValidWebhookUrl } from "@/lib/notifications/home-assistant-core";
import { householdRoundOfferableMembers } from "@/lib/notifications/household-round-access";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import PushNotificationSettings from "./PushNotificationSettings";
import LoginTelegramSettings from "./LoginTelegramSettings";
import ProfileMuteToggle from "./ProfileMuteToggle";
import HouseholdRoundSettings from "./HouseholdRoundSettings";
import HomeAssistantNotificationSettings from "./HomeAssistantNotificationSettings";
import NotificationPrefs from "./NotificationPrefs";

export const dynamic = "force-dynamic";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function workoutScheduleSummary(profileId: number): string {
  const { weekdays, hour } = inferWorkoutSchedule(profileId);
  const at = `${String(hour).padStart(2, "0")}:00`;
  if (weekdays.length === 7) return `daily ~${at}`;
  if (weekdays.length === 0) return `~${at}`;
  return `${weekdays.map((d) => WD[d]).join(", ")} ~${at}`;
}

function Section({
  title,
  scope,
  children,
  testId,
}: {
  title: string;
  scope: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section className="mt-8 first:mt-0" data-testid={testId}>
      <h2 className="section-label">{title}</h2>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">{scope}</p>
      {children}
    </section>
  );
}

// The Notifications group page (#1462 §6). It is the one settings page that is
// inherently MIXED-TIER, so it states scope PER SECTION rather than once in the
// header, and it is deliberately three sections and no more:
//
//   1. Channels      — where messages can arrive (Telegram + Web Push follow the
//                      LOGIN since #1072; the Home Assistant webhook follows the
//                      PROFILE).
//   2. Schedule      — the slot times and quiet hours, nothing else.
//   3. Message kinds — ONE row per kind carrying its enable, its config, and its
//                      channel routing. This replaced BOTH the old mega-card's
//                      per-kind toggles AND the separate kind × channel matrix,
//                      which used to answer the same question twice.
//
// (2 and 3 render from ONE client component because they write through one action —
// see NotificationPrefs.)
//
// The instance-wide Telegram BOT card left this page for Settings → Server (it is
// server config: one bot serves every profile), which is also what removes the
// admin-only block that used to sit in the middle of a member-visible page.
//
// Storage is untouched: every setting stays in its own tier's store, written by its
// own tier-scoped, uniformly-gated action module (#319).
export default async function NotificationsSettingsPage() {
  const { login, profile } = await requireSession();
  // Demo mode (#181): the read-only demo member can't configure Telegram/HA (no bot
  // is configured anyway) or edit routing — trim those write affordances.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);

  const telegram = getLoginTelegram(login.id);
  const bot = getTelegramBotConfig();
  const botConfigured = bot.telegramBotToken !== "";
  const ha = getProfileHomeAssistant(profile.id);

  // The Telegram column is deliverable for THIS profile when at least one managing
  // login (deduped by chat) has an enabled chat — the login-scoped fan-out (#1072).
  const telegramConfigured =
    botConfigured && resolveTelegramRecipients(profile.id).length > 0;
  const pushConfigured =
    isPushConfigured() && countPushSubscriptionsForLogin(login.id) > 0;
  const haConfigured = ha.enabled && isValidWebhookUrl(ha.webhookUrl);
  const householdRound = getProfileHouseholdRound(profile.id);

  return (
    <SettingsGroupLayout group="notifications" login={login} profile={profile}>
      <Section
        testId="notify-channels"
        title="Channels"
        scope={`Telegram and Web Push follow your login (${login.username}) across every profile; the Home Assistant webhook follows ${profile.name}.`}
      >
        <PageContainer width="form" className="space-y-6">
          <LoginTelegramSettings
            telegram={telegram}
            botConfigured={botConfigured}
            reviewNeeded={getNotifyReviewNeeded(login.id)}
          />
          <PushNotificationSettings />
          {!demoRestricted && (
            <>
              <HouseholdRoundSettings
                enabled={householdRound.enabled}
                memberIds={householdRound.memberIds}
                offerable={householdRoundOfferableMembers(profile.id).map(
                  (m) => ({ profileId: m.profileId, name: m.name })
                )}
                telegramConfigured={telegramConfigured}
              />
              <HomeAssistantNotificationSettings config={ha} />
            </>
          )}
        </PageContainer>
      </Section>

      {!demoRestricted && (
        <>
          <Section
            testId="notify-schedule-section"
            title="Schedule &amp; message kinds"
            scope={`When ${profile.name}'s reminders are sent, and which kinds go to which channel.`}
          >
            {/* The kind list is a matrix — it gets a reading measure rather than the
                ~520px form column the old page crammed it into (#1451.B). */}
            <PageContainer width="reading">
              <NotificationPrefs
                schedule={getNotifySchedule(profile.id)}
                workoutSummary={workoutScheduleSummary(profile.id)}
                foodTelegramEnabled={getProfileFoodTelegram(profile.id)}
                foodLoggingRelevant={isFoodLoggingRelevant(
                  getUserAge(profile.id)
                )}
                moodCheckinEnabled={getProfileMoodCheckin(profile.id)}
                moodRecapEnabled={getProfileMoodRecap(profile.id)}
                sleepDigestEnabled={getProfileSleepDigest(profile.id)}
                wakeHour={(() => {
                  // What "Auto" resolves to (#1117): the profile's typical wake
                  // hour, or null when there isn't enough sleep data yet.
                  const m = typicalWakeTime(profile.id);
                  return m == null ? null : Math.min(23, Math.round(m / 60));
                })()}
                telegramDisabled={getLoginTelegramDisabledKinds(login.id)}
                pushDisabled={getLoginPushDisabledKinds(login.id)}
                haDisabled={ha.disabledKinds}
                telegramConfigured={telegramConfigured}
                pushConfigured={pushConfigured}
                haConfigured={haConfigured}
              />
            </PageContainer>
          </Section>

          <Section
            testId="notify-mute"
            title="Mute"
            scope={`Silences ${profile.name}'s messages for your login only — other logins managing them are unaffected.`}
          >
            <PageContainer width="form">
              <ProfileMuteToggle
                profileId={profile.id}
                profileName={profile.name}
                muted={isProfileMutedForLogin(login.id, profile.id)}
                lastUnmutedManaging={wouldMuteSilenceSafety(
                  login.id,
                  profile.id
                )}
              />
            </PageContainer>
          </Section>
        </>
      )}
    </SettingsGroupLayout>
  );
}
