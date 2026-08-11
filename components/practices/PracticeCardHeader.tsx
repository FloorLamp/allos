import type { ReactNode } from "react";
import type { FrequencyPace } from "@/lib/frequency-targets";
import PracticeWeeklyProgress from "./PracticeWeeklyProgress";

export default function PracticeCardHeader({
  name,
  progress,
  subtitle,
  action,
}: {
  name: string;
  progress?: {
    count: number;
    perWeek: number;
    perWeekMax: number | null;
    pace: FrequencyPace;
    atCeiling: boolean;
    testId?: string;
  };
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          {name}
        </h2>
        {progress ? (
          <PracticeWeeklyProgress
            count={progress.count}
            perWeek={progress.perWeek}
            perWeekMax={progress.perWeekMax}
            pace={progress.pace}
            atCeiling={progress.atCeiling}
            testId={progress.testId}
          />
        ) : subtitle ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
