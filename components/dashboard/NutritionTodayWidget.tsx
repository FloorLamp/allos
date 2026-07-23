import { IconSalad } from "@tabler/icons-react";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import {
  type ProteinToday,
  proteinBasisPhrase,
  proteinTargetSummary,
} from "@/lib/protein";

// Dashboard "Nutrition today" tile (issue #1221): today's protein against the goal
// band, plus this week's daily average — a thin FORMATTER over the SAME ProteinToday
// model the Nutrition → Food gauge and the Telegram food-nudge read (getProteinToday,
// #974/#221), so the card and those surfaces can never disagree. Today is IN PROGRESS,
// so it's never colored as a shortfall; a non-tracked basis is a FLOOR ("at least"),
// per the #767 floor-copy discipline.
export default function NutritionTodayWidget({
  today,
}: {
  today: ProteinToday;
}) {
  const grams = Math.round(today.todayGrams);
  const isFloor = today.todayIntake
    ? today.todayIntake.basis !== "tracked"
    : true;
  const basis = today.todayIntake
    ? proteinBasisPhrase(today.todayIntake.basis)
    : "logged foods";
  return (
    <div className="card" data-testid="nutrition-today-widget">
      <WidgetHeader title="Nutrition today" href="/nutrition" />
      <div className="flex items-start gap-3">
        <IconSalad
          className="mt-1 h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span
              className="text-2xl font-bold tabular-nums text-slate-800 dark:text-slate-100"
              data-testid="nutrition-today-protein"
            >
              {isFloor ? "≥ " : ""}
              {grams} g
            </span>
            <span className="text-sm text-slate-500 dark:text-slate-400">
              protein today
            </span>
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-300">
            Goal {proteinTargetSummary(today.target)}
          </div>
          {today.weeklyAverageGrams != null && (
            <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              7-day average · {Math.round(today.weeklyAverageGrams)} g/day
            </div>
          )}
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            From {basis}
            {isFloor ? " — a floor, actual likely higher" : ""}.
          </div>
        </div>
      </div>
    </div>
  );
}
