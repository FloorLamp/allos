import type { GroupServingTotal } from "@/lib/food-log";
import { EmptyState } from "@/components/ui";
import FoodGroupIcon from "@/components/FoodGroupIcon";

// Presentational weekly food-servings rollup (issue #579). A pure formatter over the
// ONE computation (getWeeklyFoodRollup → rollupServings), shared by the /nutrition
// card and the Trends → Nutrition tab so they can't disagree. Servings per group this
// week, encourage-first (the catalog order the rollup already returns). The food-group
// icon (#591) is tinted by tier, so a single glyph conveys both the group and its tier.

const TIER_TINT: Record<string, string> = {
  encourage: "text-emerald-500",
  neutral: "text-slate-400",
  limit: "text-amber-500",
};

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
  return (
    <ul data-testid={testid} className="space-y-1.5">
      {rollup.map((g) => (
        <li
          key={g.slug}
          data-testid={`rollup-${g.slug}`}
          className="flex items-center justify-between gap-3 text-sm"
        >
          <span className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
            <FoodGroupIcon
              slug={g.slug}
              className={`h-4 w-4 shrink-0 ${TIER_TINT[g.tier] ?? "text-slate-400"}`}
            />
            {g.name}
          </span>
          <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
            {g.servings % 1 === 0 ? g.servings : g.servings.toFixed(1)}
            <span className="ml-1 text-xs font-normal text-slate-400">
              {g.servings === 1 ? "serving" : "servings"}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
