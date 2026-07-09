import { IconFlame } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";

// Activity streak (NEW, issue #156, fitness) — consecutive active days ending
// today or yesterday (lib/streak.currentStreak). Off by default.
export default function StreakWidget({ streak }: { streak: number }) {
  return (
    <div className="card">
      <WidgetHeader
        title="Activity streak"
        href="/training?tab=log"
        linkLabel="Log"
      />
      {streak > 0 ? (
        <div className="flex items-center gap-3">
          <IconFlame className="h-9 w-9 text-orange-500" />
          <div>
            <div className="text-3xl font-bold text-slate-800 dark:text-slate-100">
              {streak}
            </div>
            <div className="text-xs text-slate-400 dark:text-slate-500">
              day{streak === 1 ? "" : "s"} in a row
            </div>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400 dark:text-slate-500">
          No active streak — log an activity today to start one.
        </p>
      )}
    </div>
  );
}
