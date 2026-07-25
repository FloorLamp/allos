import { getRecommendationCadence, getAnxietyScaleOptIn } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import RecommendationCadenceForm from "../profile/RecommendationCadenceForm";
import AnxietyScaleForm from "../profile/AnxietyScaleForm";

export const dynamic = "force-dynamic";

// Coaching & AI (#1462) — how often this profile's recommendations refresh, and which
// daily check-in scales are offered. Both are profile-tier; the INSTANCE-wide AI
// switches (providers, tiers, the global enable) stay admin-only on Server.
export default async function CoachingSettingsPage() {
  const { login, profile } = await requireSession();
  return (
    <SettingsGroupLayout group="coaching" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        <RecommendationCadenceForm
          cadence={getRecommendationCadence(profile.id)}
          isAdmin={login.role === "admin"}
        />
        <AnxietyScaleForm enabled={getAnxietyScaleOptIn(profile.id)} />
      </PageContainer>
    </SettingsGroupLayout>
  );
}
