import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getFoodServingsOnDate,
  getWeeklyFoodRollup,
  getFoodSuggestions,
  getFoodGroupLogOrder,
} from "@/lib/queries";
import { getUserAge } from "@/lib/settings/profile-attrs";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { PageHeader, EmptyState } from "@/components/ui";
import FoodLogBar from "./FoodLogBar";
import WeeklyHabits from "./WeeklyHabits";
import { trackFoodHabit } from "./actions";
import FoodWeeklyRollup from "@/components/FoodWeeklyRollup";
import FoodSuggestions from "@/components/FoodSuggestions";

// The food-group serving log (issue #579) — the INPUT half of the nutrition umbrella.
// One-tap serving logging for today + a weekly rollup, plus the deterministic
// biomarker→food suggestions (#577) shown here as "food before pills." Habit tier,
// informational — never a calorie counter.

export default async function NutritionPage() {
  const { profile } = await requireSession();

  // Infant profiles (< 1 y) log milk/formula, not the adult food-group catalog, so
  // the serving logger is meaningless for them (issue #591). Show a calm note instead
  // of the logger; the nav entry is hidden by the same predicate, and this server-side
  // gate covers a direct URL. Eligible on unknown age (hide only on a positive match).
  if (!isFoodLoggingRelevant(getUserAge(profile.id))) {
    return (
      <div>
        <PageHeader
          title="Nutrition"
          subtitle="Food-group serving logging starts after the first year."
        />
        <div className="card" data-testid="nutrition-infant-note">
          <EmptyState message="This profile is under one year old. The food-group serving log covers the adult habit catalog (leafy greens, whole grains, and so on) — infant feeding isn't tracked here. Growth for this age lives in the Body and Timeline views." />
        </div>
      </div>
    );
  }

  const date = today(profile.id);
  const servings = getFoodServingsOnDate(profile.id, date);
  const initial: Record<string, number> = {};
  for (const [slug, n] of servings) initial[slug] = n;
  const rollup = getWeeklyFoodRollup(profile.id);
  const suggestions = getFoodSuggestions(profile.id);
  // Catalog pre-ordered so the profile's staples lead within each tier (#591).
  const groups = getFoodGroupLogOrder(profile.id);

  return (
    <div>
      <PageHeader
        title="Nutrition"
        subtitle="Log food-group servings — one tap each. Habit tier, not calorie counting."
      />

      {suggestions.length > 0 && (
        // Collapsed by default (#591): the labs-driven suggestions used to push the
        // logger below the fold on every visit. A native <details> keeps it one
        // compact line until the user opens it. The container keeps the
        // nutrition-suggestions testid; the biomarker-detail surface stays as-is.
        <details
          data-testid="nutrition-suggestions"
          className="card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
        >
          <summary
            data-testid="nutrition-suggestions-summary"
            className="flex cursor-pointer list-none items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
          >
            <span className="flex-1">
              Food suggestions from your labs
              <span className="ml-1.5 font-normal text-slate-400 dark:text-slate-500">
                · {suggestions.length}
              </span>
            </span>
            <span className="text-xs font-normal text-slate-400 dark:text-slate-500">
              Show
            </span>
          </summary>
          <div className="mt-3">
            <FoodSuggestions
              suggestions={suggestions}
              trackAction={async (fd) => {
                "use server";
                await trackFoodHabit(fd);
              }}
            />
          </div>
        </details>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Log today
          </h2>
          <FoodLogBar date={date} initial={initial} groups={groups} />
        </div>

        <div className="space-y-6 self-start">
          <WeeklyHabits profileId={profile.id} />
          <div className="card">
            <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
              This week
            </h2>
            <FoodWeeklyRollup rollup={rollup} />
          </div>
        </div>
      </div>
    </div>
  );
}
