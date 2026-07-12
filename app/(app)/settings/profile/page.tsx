import {
  getUserSex,
  getUserReproductiveStatus,
  getUserBirthdate,
  getUserAge,
  getUserFullName,
  getProfileTelegram,
  getProfileHomeAssistant,
  getTelegramBotConfig,
  getNotifySchedule,
  getTimezone,
  getWeekStart,
  getWeekMode,
  getEmergencyCardEnabled,
  getBloodType,
  getEmergencyContact,
  getSmokingHistory,
  getRiskAttributes,
  getMaxHrOverride,
  getZone2WeeklyTargetMin,
  getRecommendationCadence,
} from "@/lib/settings";
import { inferWorkoutSchedule } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { isTrainingRestricted } from "@/lib/age-gate";
import { estimateMaxHr } from "@/lib/training-zones";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import ProfileForm from "./ProfileForm";
import ProfilePhotoCard from "./ProfilePhotoCard";
import ProfileNotificationSettings from "./ProfileNotificationSettings";
import HomeAssistantNotificationSettings from "./HomeAssistantNotificationSettings";
import EmergencyCardSettings from "./EmergencyCardSettings";
import SmokingHistoryForm from "./SmokingHistoryForm";
import RiskFactorsForm from "./RiskFactorsForm";
import TrainingZonesForm from "./TrainingZonesForm";
import RecommendationCadenceForm from "./RecommendationCadenceForm";

export const dynamic = "force-dynamic";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function workoutScheduleSummary(profileId: number): string {
  const { weekdays, hour } = inferWorkoutSchedule(profileId);
  const at = `${String(hour).padStart(2, "0")}:00`;
  if (weekdays.length === 7) return `daily ~${at}`;
  if (weekdays.length === 0) return `~${at}`;
  return `${weekdays.map((d) => WD[d]).join(", ")} ~${at}`;
}

export default async function ProfileSettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // Demo mode (#181): the read-only demo member can't configure Telegram/send-test
  // (no bot is configured anyway) or change the profile photo — trim those.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);
  const fullName = getUserFullName(profile.id);
  const sex = getUserSex(profile.id);
  const reproductiveStatus = getUserReproductiveStatus(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const age = getUserAge(profile.id);
  const timezone = getTimezone(profile.id);
  const weekStart = getWeekStart(profile.id);
  const weekMode = getWeekMode(profile.id);
  const telegram = getProfileTelegram(profile.id);
  const botConfigured = getTelegramBotConfig().telegramBotToken !== "";

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={`${profile.name}’s profile — these settings apply to the person you’re currently viewing. Switch profiles in the header to edit someone else.`}
      />
      <SettingsTabs isAdmin={isAdmin} />
      <ProfilePhotoCard profile={profile} disabled={demoRestricted} />
      <ProfileForm
        fullName={fullName}
        sex={sex}
        reproductiveStatus={reproductiveStatus}
        birthdate={birthdate}
        age={age}
        timezone={timezone}
        weekStart={weekStart}
        weekMode={weekMode}
      />
      {!isTrainingRestricted(profile.id) && (
        <TrainingZonesForm
          maxHrOverride={getMaxHrOverride(profile.id)}
          zone2Target={getZone2WeeklyTargetMin(profile.id)}
          estimatedMaxHr={age != null ? estimateMaxHr(age) : null}
        />
      )}
      <SmokingHistoryForm history={getSmokingHistory(profile.id)} />
      <RiskFactorsForm attributes={getRiskAttributes(profile.id)} />
      <RecommendationCadenceForm
        cadence={getRecommendationCadence(profile.id)}
        isAdmin={isAdmin}
      />
      {!demoRestricted && (
        <>
          <ProfileNotificationSettings
            telegram={telegram}
            botConfigured={botConfigured}
            schedule={getNotifySchedule(profile.id)}
            workoutSummary={workoutScheduleSummary(profile.id)}
          />
          <HomeAssistantNotificationSettings
            config={getProfileHomeAssistant(profile.id)}
          />
        </>
      )}
      <EmergencyCardSettings
        enabled={getEmergencyCardEnabled(profile.id)}
        bloodType={getBloodType(profile.id)}
        contact={getEmergencyContact(profile.id)}
      />
    </div>
  );
}
