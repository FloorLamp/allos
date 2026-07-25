import { getUserAge, getExcludedFoodGroups } from "@/lib/settings";
import { requireSession } from "@/lib/auth";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { FOOD_GROUPS } from "@/lib/food-groups";
import PageContainer from "@/components/PageContainer";
import SettingsGroupLayout from "../SettingsGroupLayout";
import DietaryPreferencesForm from "../profile/DietaryPreferencesForm";

export const dynamic = "force-dynamic";

// Nutrition (#1462) — the profile-tier dietary preferences (#975): which food groups
// to leave out of suggestions and guidance.
//
// Life-stage gate: meaningless for an infant (milk/formula, not the adult food-group
// catalog), so the group drops out of the nav on the same predicate the Food tab
// uses — but the route explains itself rather than 404-ing (see the Training page).
export default async function NutritionSettingsPage() {
  const { login, profile } = await requireSession();
  const relevant = isFoodLoggingRelevant(getUserAge(profile.id));
  return (
    <SettingsGroupLayout group="nutrition" login={login} profile={profile}>
      <PageContainer width="form" className="space-y-6">
        {relevant ? (
          <DietaryPreferencesForm
            excluded={getExcludedFoodGroups(profile.id)}
            groups={FOOD_GROUPS.map((g) => ({
              slug: g.slug,
              name: g.name,
              tier: g.tier,
            }))}
          />
        ) : (
          <div className="card" data-testid="nutrition-settings-unavailable">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Food-group preferences don&rsquo;t apply to {profile.name} yet.
            </p>
          </div>
        )}
      </PageContainer>
    </SettingsGroupLayout>
  );
}
