import type { GroupServingTotal } from "@/lib/food-daily-totals";
import { EmptyState } from "@/components/ui";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";

// Presentational weekly food-servings rollup (issue #579). A pure formatter over the
// ONE computation (getWeeklyFoodRollup → rollupServings), shared by the /nutrition
// card and the Trends → Nutrition tab so they can't disagree. The summary orders groups
// by servings descending, then alphabetically for ties, so its hierarchy is immediately
// legible instead of exposing the catalog's internal order. The food-group icon (#591)
// is tinted by tier, so a single glyph conveys both the group and its tier.

export default function FoodWeeklyRollup({
  rollup,
  testid = "food-weekly-rollup",
}: {
  rollup: GroupServingTotal[];
  testid?: string;
}) {
  if (rollup.length === 0) {
    return (
      <div data-testid={testid}>
        <EmptyState message="No servings logged this week yet." />
      </div>
    );
  }
  const orderedRollup = [...rollup].sort(
    (a, b) =>
      b.servings - a.servings ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return (
    <ul data-testid={testid} className="space-y-1.5">
      {orderedRollup.map((g) => (
        <li
          key={g.slug}
          data-testid={`rollup-${g.slug}`}
          className="flex items-center gap-2 text-sm"
        >
          <FoodGroupIcon
            slug={g.slug}
            className={`h-4 w-4 shrink-0 ${FOOD_GROUP_TIER_TINT[g.tier]}`}
          />
          <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
            {g.servings % 1 === 0 ? g.servings : g.servings.toFixed(1)}
          </span>
          <span className="text-slate-700 dark:text-slate-200">{g.name}</span>
        </li>
      ))}
    </ul>
  );
}
