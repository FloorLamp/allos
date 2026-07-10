import {
  getUserSex,
  getUserReproductiveStatus,
  getUserBirthdate,
  getUserAge,
  getUserFullName,
  getProfileTelegram,
  getTelegramBotConfig,
  getNotifySchedule,
  getTimezone,
  getWeekStart,
  getWeekMode,
  getEmergencyCardEnabled,
  getBloodType,
  getEmergencyContact,
  getSmokingHistory,
} from "@/lib/settings";
import { inferWorkoutSchedule } from "@/lib/queries";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import ProfileForm from "./ProfileForm";
import ProfilePhotoCard from "./ProfilePhotoCard";
import ProfileNotificationSettings from "./ProfileNotificationSettings";
import EmergencyCardSettings from "./EmergencyCardSettings";
import SmokingHistoryForm from "./SmokingHistoryForm";

export const dynamic = "force-dynamic";

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function workoutScheduleSummary(profileId: number): string {
  const { weekdays, hour } = inferWorkoutSchedule(profileId);
  const at = `${String(hour).padStart(2, "0")}:00`;
  if (weekdays.length === 7) return `daily ~${at}`;
  if (weekdays.length === 0) return `~${at}`;
  return `${weekdays.map((d) => WD[d]).join(", ")} ~${at}`;
}

export default function ProfileSettingsPage() {
  const { login, profile } = requireSession();
  const isAdmin = login.role === "admin";
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
      <SettingsTabs
        isAdmin={isAdmin}
        hideEquipment={isTrainingRestricted(profile.id)}
      />
      <ProfilePhotoCard profile={profile} />
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
      <SmokingHistoryForm history={getSmokingHistory(profile.id)} />
      <ProfileNotificationSettings
        telegram={telegram}
        botConfigured={botConfigured}
        schedule={getNotifySchedule(profile.id)}
        workoutSummary={workoutScheduleSummary(profile.id)}
      />
      <EmergencyCardSettings
        enabled={getEmergencyCardEnabled(profile.id)}
        bloodType={getBloodType(profile.id)}
        contact={getEmergencyContact(profile.id)}
      />
    </div>
  );
}
