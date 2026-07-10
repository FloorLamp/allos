import { IconFlame } from "@tabler/icons-react";
import WidgetHeader from "./WidgetHeader";

// Activity streak (NEW, fitness). The headline is the rest-tolerant
// "flexible" streak (lib/streak.flexibleStreak) — active days in the current run,
// tolerating the odd rest day — so a healthy training rhythm isn't reset by a
// single day off. The strict consecutive-days streak (currentStreak) is kept as
// a secondary line (#44 item 2). Off by default.
export default function StreakWidget({
  streak,
  strictStreak = 0,
}: {
  streak: number;
  strictStreak?: number;
}) {
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
              active day{streak === 1 ? "" : "s"}
              {strictStreak > 0 && <> · {strictStreak}-day streak</>}
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
