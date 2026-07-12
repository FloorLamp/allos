import type { GroupServingTotal } from "@/lib/food-log";
import { EmptyState } from "@/components/ui";

// Presentational weekly food-servings rollup (issue #579). A pure formatter over the
// ONE computation (getWeeklyFoodRollup → rollupServings), shared by the /nutrition
// card and the Trends → Nutrition tab so they can't disagree. Servings per group this
// week, encourage-first (the catalog order the rollup already returns).

const TIER_DOT: Record<string, string> = {
  encourage: "bg-emerald-500",
  neutral: "bg-slate-400",
  limit: "bg-amber-500",
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
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${TIER_DOT[g.tier] ?? "bg-slate-400"}`}
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
