import {
  getUserAge,
  getMaxHrOverride,
  getStepsDailyTarget,
  getZone2WeeklyTargetMin,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { estimateMaxHr } from "@/lib/training-zones";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import TrainingZonesForm from "../profile/TrainingZonesForm";

export const dynamic = "force-dynamic";

// Training (#1462) — the profile-tier training group: heart-rate zones and the
// weekly zone-2 target.
//
// Age gate: a training-restricted profile drops this group from the settings nav
// (visibleSettingsGroups), but the ROUTE still exists and explains itself rather
// than 404-ing — the nav filter is relevance, not access, and a bookmark should
// never dead-end.
export default async function TrainingSettingsPage() {
  const { login, profile } = await requireSession();
  const age = getUserAge(profile.id);
  const restricted = isTrainingRestricted(profile.id);
  return (
    <SettingsGroupLayout group="training" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        {restricted ? (
          <div className="card" data-testid="training-settings-unavailable">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Training settings don&rsquo;t apply to {profile.name} yet.
            </p>
          </div>
        ) : (
          <TrainingZonesForm
            maxHrOverride={getMaxHrOverride(profile.id)}
            zone2Target={getZone2WeeklyTargetMin(profile.id)}
            estimatedMaxHr={age != null ? estimateMaxHr(age) : null}
            stepsTarget={getStepsDailyTarget(profile.id)}
          />
        )}
      </PageContainer>
    </SettingsGroupLayout>
  );
}
