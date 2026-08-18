import {
  getProfileAge,
  getMaxHrOverride,
  getStepsDailyTarget,
  getZone2WeeklyTargetMin,
} from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { estimateMaxHr } from "@/lib/training-zones";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import TrainingZonesForm from "../profile/TrainingZonesForm";
import { redirect } from "next/navigation";
import { isTrainingRelevant } from "@/lib/life-stage";

export const dynamic = "force-dynamic";

// Training (#1462) — the profile-tier training group: heart-rate zones and the
// weekly zone-2 target.
//
export default async function TrainingSettingsPage() {
  const { login, profile } = await requireSession();
  const age = getProfileAge(profile.id);
  if (!isTrainingRelevant(age)) redirect("/settings");
  return (
    <SettingsGroupLayout group="training" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <TrainingZonesForm
          maxHrOverride={getMaxHrOverride(profile.id)}
          zone2Target={getZone2WeeklyTargetMin(profile.id)}
          estimatedMaxHr={age != null ? estimateMaxHr(age) : null}
          stepsTarget={getStepsDailyTarget(profile.id)}
        />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
