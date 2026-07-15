import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFoodRollupInRange } from "@/lib/queries";
import type { DateRange } from "@/lib/timeline-format";
import { shiftDateStr } from "@/lib/date";
import FoodWeeklyRollup from "@/components/FoodWeeklyRollup";

// Trends → Nutrition tab (issue #579): the food-group servings rollup over the shared
// date range. Same pure rollup as the /nutrition weekly card — a formatter over one
// computation, honoring the Trends date-range control.

export default async function NutritionSection({
  range,
}: {
  range: DateRange;
}) {
  const { profile } = await requireSession();
  const todayStr = today(profile.id);
  const from = range.from ?? shiftDateStr(todayStr, -29);
  const to = range.to ?? todayStr;
  const rollup = getFoodRollupInRange(profile.id, from, to);

  return (
    <div className="card" data-testid="nutrition-trends">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Food servings
        </h2>
        <Link
          href="/nutrition"
          className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-400"
        >
          Log servings →
        </Link>
      </div>
      <FoodWeeklyRollup rollup={rollup} testid="nutrition-trends-rollup" />
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Servings logged per food group over the selected range. Informational —
        the habit tier, not calorie tracking.
      </p>
    </div>
  );
}
