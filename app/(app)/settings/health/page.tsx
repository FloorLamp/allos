import {
  getProfileSex,
  getProfileReproductiveStatus,
  getProfileBirthdate,
  getProfileAge,
  getProfileFullName,
  getTimezone,
  getHomeLocation,
  getSkinType,
  getWeekStart,
  getWeekMode,
  getFreeDays,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import ProfileForm from "../profile/ProfileForm";
import ProfilePhotoCard from "../profile/ProfilePhotoCard";
import FreeDaysForm from "../profile/FreeDaysForm";

export const dynamic = "force-dynamic";

// Health profile (#1462) — who the tracked person IS: photo, name, sex, birthdate,
// timezone, and the week their routine follows. This is the topic-first successor to
// the old Profile tab's "Identity & localization" section; the tab's other sections
// became their own groups (Training, Nutrition, Coaching & AI, Privacy), which is
// what retired the anchor jump-nav and the ~4,900px scroll wall.
//
// The two niche one-time fields — home location and Fitzpatrick skin type — moved
// behind ProfileForm's stateless "Advanced" fold (§3) rather than sitting at equal
// rank with the birthdate.
export default async function HealthProfileSettingsPage() {
  const { login, profile } = await requireSession();
  // Demo mode (#181): the read-only demo member can't change the profile photo.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);
  const home = getHomeLocation(profile.id);
  return (
    <SettingsGroupLayout group="health" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <ProfilePhotoCard profile={profile} disabled={demoRestricted} />
        <ProfileForm
          fullName={getProfileFullName(profile.id)}
          sex={getProfileSex(profile.id)}
          reproductiveStatus={getProfileReproductiveStatus(profile.id)}
          birthdate={getProfileBirthdate(profile.id)}
          age={getProfileAge(profile.id)}
          timezone={getTimezone(profile.id)}
          weekStart={getWeekStart(profile.id)}
          weekMode={getWeekMode(profile.id)}
          homeLat={home?.lat ?? null}
          homeLng={home?.lng ?? null}
          skinType={getSkinType(profile.id)}
        />
        <FreeDaysForm freeDays={getFreeDays(profile.id)} />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
