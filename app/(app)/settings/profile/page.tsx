import {
  getUserSex,
  getUserReproductiveStatus,
  getUserBirthdate,
  getUserAge,
  getUserFullName,
  getTimezone,
  getHomeLocation,
  getSkinType,
  getWeekStart,
  getWeekMode,
  getMaxHrOverride,
  getZone2WeeklyTargetMin,
  getRecommendationCadence,
  getExcludedFoodGroups,
  getMentalHealthShareFull,
  getProfileCrisisResourcesOverride,
} from "@/lib/settings";
import { formatCrisisResourcesText } from "@/lib/crisis-resources";
import { requireSession } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { isTrainingRestricted } from "@/lib/age-gate";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { estimateMaxHr } from "@/lib/training-zones";
import { FOOD_GROUPS } from "@/lib/food-groups";
import { PageHeader } from "@/components/ui";
import SettingsTabs from "../SettingsTabs";
import ProfileAnchorNav, { type AnchorSection } from "./ProfileAnchorNav";
import ProfileForm from "./ProfileForm";
import ProfilePhotoCard from "./ProfilePhotoCard";
import TrainingZonesForm from "./TrainingZonesForm";
import RecommendationCadenceForm from "./RecommendationCadenceForm";
import DietaryPreferencesForm from "./DietaryPreferencesForm";
import MentalHealthPrivacyForm from "./MentalHealthPrivacyForm";
import CrisisResourcesEditor from "@/components/CrisisResourcesEditor";
import { saveProfileCrisisResources } from "./actions";

export const dynamic = "force-dynamic";

// The Profile tab (#928): the tracked person's identity/localization, training
// zones, and coaching cadence — grouped into titled <section> blocks with a sticky
// anchor jump-nav (decided over sub-tabs). The health-data cards (smoking / risk /
// emergency) moved to /medical/background, and both notification cards moved to the
// Notifications tab, so this page is a handful of cards in 2–3 sections.
export default async function ProfileSettingsPage() {
  const { login, profile } = await requireSession();
  const isAdmin = login.role === "admin";
  // Demo mode (#181): the read-only demo member can't change the profile photo.
  const demoRestricted = isDemoRestricted(isDemoMode(), login.role);
  const fullName = getUserFullName(profile.id);
  const sex = getUserSex(profile.id);
  const reproductiveStatus = getUserReproductiveStatus(profile.id);
  const birthdate = getUserBirthdate(profile.id);
  const age = getUserAge(profile.id);
  const timezone = getTimezone(profile.id);
  const weekStart = getWeekStart(profile.id);
  const weekMode = getWeekMode(profile.id);
  const home = getHomeLocation(profile.id);
  const trainingShown = !isTrainingRestricted(profile.id);
  // Dietary preferences (#975) — meaningless for an infant (milk/formula, not the adult
  // food-group catalog), hidden on the same predicate the Food tab uses.
  const nutritionShown = isFoodLoggingRelevant(age);

  // The anchor nav must list only the sections actually rendered — Training is
  // dropped for an age-restricted profile, so its anchor is dropped too.
  const sections: AnchorSection[] = [
    { id: "identity", label: "Identity & localization" },
    ...(trainingShown
      ? [{ id: "training", label: "Training" } as AnchorSection]
      : []),
    ...(nutritionShown
      ? [{ id: "nutrition", label: "Nutrition" } as AnchorSection]
      : []),
    { id: "coaching", label: "Coaching" },
    { id: "privacy", label: "Privacy & support" },
  ];

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle={`${profile.name}’s profile — these settings apply to the person you’re currently viewing. Switch profiles in the header to edit someone else.`}
      />
      <SettingsTabs isAdmin={isAdmin} />
      <div className="gap-8 sm:grid sm:grid-cols-[12rem_1fr]">
        <div className="sm:sticky sm:top-4 sm:self-start">
          <ProfileAnchorNav sections={sections} />
        </div>
        <div className="space-y-6">
          <section id="identity" className="scroll-mt-4 space-y-6">
            <h2 className="section-label">Identity &amp; localization</h2>
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
              homeLat={home?.lat ?? null}
              homeLng={home?.lng ?? null}
              skinType={getSkinType(profile.id)}
            />
          </section>
          {trainingShown && (
            <section id="training" className="scroll-mt-4 space-y-6">
              <h2 className="section-label">Training</h2>
              <TrainingZonesForm
                maxHrOverride={getMaxHrOverride(profile.id)}
                zone2Target={getZone2WeeklyTargetMin(profile.id)}
                estimatedMaxHr={age != null ? estimateMaxHr(age) : null}
              />
            </section>
          )}
          {nutritionShown && (
            <section id="nutrition" className="scroll-mt-4 space-y-6">
              <h2 className="section-label">Nutrition</h2>
              <DietaryPreferencesForm
                excluded={getExcludedFoodGroups(profile.id)}
                groups={FOOD_GROUPS.map((g) => ({
                  slug: g.slug,
                  name: g.name,
                  tier: g.tier,
                }))}
              />
            </section>
          )}
          <section id="coaching" className="scroll-mt-4 space-y-6">
            <h2 className="section-label">Coaching</h2>
            <RecommendationCadenceForm
              cadence={getRecommendationCadence(profile.id)}
              isAdmin={isAdmin}
            />
          </section>
          <section id="privacy" className="scroll-mt-4 space-y-6">
            <h2 className="section-label">Privacy &amp; support</h2>
            <MentalHealthPrivacyForm
              shareFull={getMentalHealthShareFull(profile.id)}
            />
            <CrisisResourcesEditor
              action={saveProfileCrisisResources}
              initialText={formatCrisisResourcesText(
                getProfileCrisisResourcesOverride(profile.id) ?? []
              )}
              title="Crisis resources (override)"
              description="Optional per-profile override of the instance-wide crisis resources — for a mixed-region household. Leave empty to use the instance default."
              testid="crisis-resources-profile"
            />
          </section>
        </div>
      </div>
    </div>
  );
}
