import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import {
  getFoodServingsOnDate,
  getWeeklyFoodRollup,
  getFoodSuggestions,
} from "@/lib/queries";
import { PageHeader } from "@/components/ui";
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
  const date = today(profile.id);
  const servings = getFoodServingsOnDate(profile.id, date);
  const initial: Record<string, number> = {};
  for (const [slug, n] of servings) initial[slug] = n;
  const rollup = getWeeklyFoodRollup(profile.id);
  const suggestions = getFoodSuggestions(profile.id);

  return (
    <div>
      <PageHeader
        title="Nutrition"
        subtitle="Log food-group servings — one tap each. Habit tier, not calorie counting."
      />

      {suggestions.length > 0 && (
        <div
          data-testid="nutrition-suggestions"
          className="card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
        >
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Food suggestions from your labs
          </h2>
          <FoodSuggestions
            suggestions={suggestions}
            trackAction={async (fd) => {
              "use server";
              await trackFoodHabit(fd);
            }}
          />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="card">
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Log today
          </h2>
          <FoodLogBar date={date} initial={initial} />
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
