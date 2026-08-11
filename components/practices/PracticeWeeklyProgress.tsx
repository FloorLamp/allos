import { practiceCadenceText, PRACTICE_PLENTY_TEXT } from "@/lib/practice";
import {
  frequencyPaceLabel,
  type FrequencyPace,
} from "@/lib/frequency-targets";
import { PACE_BADGE_CLASS } from "@/lib/pace-presentation";

export default function PracticeWeeklyProgress({
  count,
  perWeek,
  perWeekMax,
  label,
  noun = "day",
  pace,
  atCeiling,
  testId,
}: {
  count: number;
  perWeek: number;
  perWeekMax: number | null;
  label?: string;
  noun?: string;
  pace: FrequencyPace;
  atCeiling: boolean;
  testId?: string;
}) {
  const countText =
    count === 0
      ? `No ${noun}s`
      : count === 1
        ? `1 ${noun}`
        : `${count} ${noun}s`;

  return (
    <div data-testid={testId}>
      {label && (
        <div className="font-medium text-slate-800 dark:text-slate-100">
          {label}
        </div>
      )}
      <div
        className={`${label ? "mt-0.5 " : ""}text-sm text-slate-500 dark:text-slate-400`}
      >
        <span className="font-semibold tabular-nums text-slate-700 dark:text-slate-200">
          {countText} this week
        </span>
        {" · "}Target {practiceCadenceText(perWeek, perWeekMax)}
        <span
          className={`badge ml-1.5 ${
            atCeiling
              ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
              : PACE_BADGE_CLASS[pace]
          }`}
        >
          {atCeiling ? PRACTICE_PLENTY_TEXT : frequencyPaceLabel(pace)}
        </span>
      </div>
    </div>
  );
}
