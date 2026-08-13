import {
  getLoginTelegram,
  getProfileFoodTelegram,
  getProfileMoodCheckin,
  getProfileMoodRecap,
  getProfileSleepDigest,
  getProfileWearReminder,
  getProfileHomeAssistant,
  getTelegramBotConfig,
  getNotifySchedule,
  getProfileAge,
  getLoginTelegramDisabledKinds,
  getLoginPushDisabledKinds,
  getLoginEmailNotify,
  getLoginEmailDisabledKinds,
  isEmailConfigured,
  getNotifyReviewNeeded,
  isProfileMutedForLogin,
  getProfileHouseholdRound,
  getLoginDigestDemotions,
  getDisplayFormatPrefs,
  getSetting,
} from "@/lib/settings";
import { subHourlySlotsAtRisk } from "@/lib/notifications/schedule";
import { formatClockMinutes } from "@/lib/format-date";
import { arrivalStatistics } from "@/lib/notifications/digest-schedule";
import { getDigestTimeSuggestion } from "@/lib/queries/digest-time-suggestion";
import { wearReminderPausedNote } from "@/lib/queries/stream-lifecycle";
import { getSleepArrivals } from "@/lib/queries/metrics";
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
import {
  loginEmailAddress,
  resolveEmailRecipients,
} from "@/lib/notifications/email";
import { isValidWebhookUrl } from "@/lib/notifications/home-assistant-core";
import { channelReadiness } from "@/lib/notifications/matrix-liveness";
import { householdRoundOfferableMembers } from "@/lib/notifications/household-round-access";
import { notifyScopeForLogin } from "@/lib/notify-scope-db";
import { notifyScopeCaption } from "@/lib/notify-scope";
import { profileUnroutableReason } from "@/lib/queries/household-setup";
import { today } from "@/lib/db";
import NotifyScopeEditor from "@/components/NotifyScopeEditor";
import { Notice } from "@/components/Notice";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import PushNotificationSettings from "./PushNotificationSettings";
import LoginTelegramSettings from "./LoginTelegramSettings";
import EmailNotificationSettings from "./EmailNotificationSettings";
import ProfileMuteToggle from "./ProfileMuteToggle";
import HouseholdRoundSettings from "./HouseholdRoundSettings";
import HomeAssistantNotificationSettings from "./HomeAssistantNotificationSettings";
import NotificationPrefs from "./NotificationPrefs";
import DigestTuneSettings from "./DigestTuneSettings";

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
// inherently MIXED-TIER — the registry now SAYS so (`tier: "mixed"`, #1868 §4), so the
// header states the mixed scope once and these per-section strings are the
// fine-grained layer rather than a second, competing labeling system. It is
// deliberately three sections and no more:
//
//   1. Channels      — where messages can arrive (Telegram + Web Push follow the
//                      LOGIN since #1072; the Home Assistant webhook follows the
//                      PROFILE). Each card configures the CHANNEL — enable, target,
//                      credentials, send-test — and nothing per-kind.
//   2. Schedule      — the slot times and quiet hours, nothing else.
//   3. Message kinds — ONE row per kind carrying its enable, its config, and its
//                      channel routing. This replaced BOTH the old mega-card's
//                      per-kind toggles AND the separate kind × channel matrix,
//                      which used to answer the same question twice. As of #1868 §1
//                      that is finally true for ALL THREE columns: the Home Assistant
//                      card's own per-kind grid wrote the SAME
//                      `ha_notify_disabled_kinds` key as the matrix's HA column (26
//                      checkboxes for 13 booleans), and it is gone. Each column header
//                      also carries a tri-state select-all (#1868 §2) that never
//                      sweeps the safety kinds.
//
// Below them sit the two per-login REDUCTIONS — the morning digest's per-category
// demotion (#1714) and the per-profile mute (#1072/#1324). Neither is a new
// settings-only feature: each MIRRORS a control that already rides a message, so the
// same preference is reachable both where it annoys you and where you go looking for
// it (#221's one storage, two surfaces).
//
// And, for an ADMIN only, one ADDITION above them: the per-profile notification
// scope (#2345). It is the same #221 shape — one storage (`login_profiles`), one
// action (`setGrants`), two surfaces — with Settings → Family as the authoritative
// editor for any login and this page as the same control scoped to SELF. It is here
// because Family is admin-only and about OTHER people's logins, and an opt-in that
// only exists where the person is not sent is not an opt-in (#2299). Members are not
// offered it: for a member that row IS their access, which stays admin-managed.
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
  // An ADMIN's notification scope (#2345). The fan-out deliberately does not inherit
  // admin-sees-all, so an admin receives nothing about a profile they have not opted
  // into — and Settings → Family (admin-only, about OTHER people's logins) is not
  // where someone goes to change what buzzes their own phone. Same control, same
  // action, scoped to `self`. Members are not offered it: for a member the row IS
  // their access, so it stays an admin-managed decision.
  const notifyScope =
    login.role === "admin" ? notifyScopeForLogin(login.id) : null;

  const smtpConfigured = isEmailConfigured();
  // What each matrix column needs before it can carry anything (#2565 part B). This is
  // the SAME deliverability test the four `*Configured` booleans carried — the AND of
  // the two halves is unchanged — split into the instance-wide half and the
  // per-recipient half, plus which TIER owns that recipient. The split is the point:
  // this page is deliberately mixed-tier, and "not set up" meant three different
  // obligations (an admin's, this login's, this profile's) with nothing on screen to
  // tell them apart.
  //
  // WHICH tier owns which column is declared in `channelReadiness`, not here — this
  // page supplies FACTS only. Web Push in particular has NO admin step despite its
  // instance-wide VAPID keypair (it is generated lazily on first use, and there is no
  // control for it on Settings → Server), so `isPushConfigured()` is part of the
  // LOGIN-tier fact rather than a server-tier one. See that module's header.
  //
  // TWO of these reads — the Telegram and Email recipient fan-outs — used to be skipped
  // by a short-circuit when their server half was false, and now always run. Both are
  // read-only settings/fan-out queries on a force-dynamic page that is not a hot path,
  // and the fact shape is worth more than the skip. Push's own short-circuit survives
  // verbatim inside `pushSubscribed`, which is byte-identical to main's `pushConfigured`.
  const readiness = channelReadiness({
    telegramBotConfigured: botConfigured,
    telegramRecipient: resolveTelegramRecipients(profile.id).length > 0,
    pushSubscribed:
      isPushConfigured() && countPushSubscriptionsForLogin(login.id) > 0,
    haWebhook: ha.enabled && isValidWebhookUrl(ha.webhookUrl),
    smtpConfigured,
    emailRecipient: resolveEmailRecipients(profile.id).length > 0,
  });
  const telegramConfigured =
    readiness.telegram.serverReady && readiness.telegram.targetReady;
  const householdRound = getProfileHouseholdRound(profile.id);

  // UNROUTABLE (#2173) — said at the exact place someone would fix it. This profile
  // would send something and NOTHING would carry it: either no login receives it at all
  // (the notification edge set is empty — grants UNION own-profile, and the admin ROLE
  // deliberately is not a source) or every login that does has no channel configured.
  // The tick treats that as a non-error, so without this line the state is invisible.
  //
  // It is a RENDERED note, never a send, and it cannot double-fire with the
  // delivery-status error the channel cards already show: that marker records a channel
  // that was ATTEMPTED and FAILED, and this fires only when there is nothing to attempt.
  const unroutableReason = profileUnroutableReason(
    profile.id,
    today(profile.id)
  );

  // Sub-hourly honesty check (#2121 constraint 4): the scheduler records its
  // OBSERVED cadence each tick (`notify_tick_interval_min`); when a configured
  // slot time is sub-hourly and that cadence can't land on it, say so here rather
  // than delivering late silently. Absent (tick never ran) reads as hourly.
  const schedule = getNotifySchedule(profile.id);
  const observedTickMin = Number(getSetting("notify_tick_interval_min")) || 60;
  // The reader's clock convention (#964/#1163), for DISPLAY copy on this page only —
  // captions, the suggestion card, the Auto slot label, the quiet-hours options and
  // the sub-hourly warning. Every stored value, form field value and wire token on
  // this surface still serializes through `formatNotifyTime` ("HH:MM", 24-h): this
  // splits display from storage and touches no storage. #2255 §4.
  const { timeFormat } = getDisplayFormatPrefs(login.id);
  const atRiskMinutes = subHourlySlotsAtRisk(
    [
      ...Object.values(schedule.supplementMinutes),
      schedule.digestMinute,
      schedule.weeklyRecapDay != null ? schedule.weeklyRecapMinute : null,
    ],
    observedTickMin
  );
  const subHourlyAtRisk =
    atRiskMinutes.length > 0
      ? {
          times: [...new Set(atRiskMinutes)]
            .sort((a, b) => a - b)
            .map((m) => formatClockMinutes(timeFormat, m)),
          intervalMin: observedTickMin,
        }
      : null;

  return (
    <SettingsGroupLayout group="notifications" login={login} profile={profile}>
      <Section
        testId="notify-channels"
        title="Channels"
        scope={`Telegram, Web Push, and Email follow your login (${login.username}) across every profile; the Home Assistant webhook follows ${profile.name}.`}
      >
        <PageContainer width="form" className="space-y-6">
          {unroutableReason && (
            <Notice
              tone="amber"
              icon
              testid="notify-unroutable"
              title="Nothing receives this profile's notifications"
            >
              {unroutableReason === "no-managing-login"
                ? `${profile.name}'s reminders are built and delivered to no one — no login receives them. An admin can add one in People & access.`
                : `${profile.name}'s reminders are built and delivered to no one — every login that receives them has no channel configured.`}
            </Notice>
          )}
          <LoginTelegramSettings
            telegram={telegram}
            botConfigured={botConfigured}
            reviewNeeded={getNotifyReviewNeeded(login.id)}
          />
          <PushNotificationSettings />
          {!demoRestricted && (
            <>
              <EmailNotificationSettings
                email={getLoginEmailNotify(login.id)}
                address={loginEmailAddress(login.id)}
                smtpConfigured={smtpConfigured}
              />
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

      {notifyScope && (
        <Section
          testId="notify-scope-section"
          title="Profiles"
          scope={notifyScopeCaption(true, login.username)}
        >
          <PageContainer width="form">
            <NotifyScopeEditor
              login={{
                id: login.id,
                username: login.username,
                own_profile_id: notifyScope.ownProfileId,
              }}
              profiles={notifyScope.profiles}
              granted={notifyScope.granted}
              access={notifyScope.access}
              self
              // The Section above already carries the heading + caption.
              chrome="bare"
            />
          </PageContainer>
        </Section>
      )}

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
                schedule={schedule}
                workoutSummary={workoutScheduleSummary(profile.id)}
                foodTelegramEnabled={getProfileFoodTelegram(profile.id)}
                foodLoggingRelevant={isFoodLoggingRelevant(
                  getProfileAge(profile.id)
                )}
                moodCheckinEnabled={getProfileMoodCheckin(profile.id)}
                moodRecapEnabled={getProfileMoodRecap(profile.id)}
                sleepDigestEnabled={getProfileSleepDigest(profile.id)}
                wearReminderEnabled={getProfileWearReminder(profile.id)}
                // #2162 constraint 5: while the shared expected-active gate is closed
                // the reminder cannot fire, so the row says so rather than implying
                // tonight's send. Derived — the setting itself is never rewritten.
                wearReminderPaused={wearReminderPausedNote(profile.id)}
                // What the MORNING SLOT's "Auto" resolves to (#1117): the profile's
                // typical wake minute, or null when there isn't enough sleep data
                // yet. At minute grain (#2121) it is passed unrounded. The digest
                // does not read it — #2211 removed `auto` from the digest.
                wakeMinute={typicalWakeTime(profile.id)}
                // The measured sleep-arrival distribution (#2214) the Dynamic
                // digest's deadline derives from, or its stated no-answer. Read
                // once here and formatted once, by describeDigestSchedule.
                arrivalStats={arrivalStatistics(getSleepArrivals(profile.id))}
                // The #2217 suggestion, resolved by the ONE function the in-digest
                // line also reads — so the Settings row and that line are the same
                // finding under the same episode key, and dismissing either
                // dismisses both.
                timeSuggestion={getDigestTimeSuggestion(profile.id)}
                tickMinutes={observedTickMin}
                timeFormat={timeFormat}
                subHourlyAtRisk={subHourlyAtRisk}
                telegramDisabled={getLoginTelegramDisabledKinds(login.id)}
                pushDisabled={getLoginPushDisabledKinds(login.id)}
                haDisabled={ha.disabledKinds}
                emailDisabled={getLoginEmailDisabledKinds(login.id)}
                // #2565 part B: which columns can carry anything, and — when one
                // cannot — whose setup step is missing. Render-only; no key on this
                // page is written by it.
                readiness={readiness}
                isAdmin={login.role === "admin"}
                profileName={profile.name}
              />
            </PageContainer>
          </Section>

          <Section
            testId="notify-digest-tune"
            title="Morning digest"
            scope={`Which lines your morning digest routinely carries — your login only, across every profile. This is the mirror of the digest message's own ⚙️ Tune control, not a second setting, so it stays collapsed to its current state.`}
          >
            <PageContainer width="form">
              <DigestTuneSettings demoted={getLoginDigestDemotions(login.id)} />
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
