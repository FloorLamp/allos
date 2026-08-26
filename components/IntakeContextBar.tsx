"use client";

import { IconAdjustmentsHorizontal } from "@tabler/icons-react";
import CompactDateMenu from "@/components/CompactDateMenu";
import IconButton from "@/components/IconButton";
import SegmentedControl from "@/components/SegmentedControl";
import AddSupplementModal, {
  type AddSupplementModalProps,
} from "@/components/nutrition/AddSupplementModal";

type SharedProps = {
  today: string;
  days: readonly { date: string; label: string }[];
  value: string;
  onChange: (date: string) => void;
  context?: { label: string; value?: string };
  todayContext?: string | null;
};

type Props = SharedProps &
  (
    | {
        purpose: "food-log";
        status: { kind: "servings"; count: number };
        action: { kind: "food-preferences"; onActivate: () => void };
      }
    | {
        purpose: "supplement-review";
        status: { kind: "taken"; taken: number; total: number };
        action: { kind: "add-supplement"; modal: AddSupplementModalProps };
      }
  );

export default function IntakeContextBar({
  purpose,
  today,
  days,
  value,
  onChange,
  context,
  todayContext,
  status,
  action,
}: Props) {
  const food = purpose === "food-log";
  const prefix = food ? "food" : "supplement";
  const title = food ? "Food Log" : "Supplements";
  const choose = food ? "Choose day to log" : "Choose day to review";
  const group = food ? "Day to log" : "Day to review";
  const activeDay = days.find((day) => day.date === value) ?? days[0];
  const currentContext = value === today ? todayContext : null;
  const [compactStatus, expandedStatus] =
    status.kind === "servings"
      ? [`${status.count} ${status.count === 1 ? "serving" : "servings"}`, null]
      : status.total === 0
        ? ["0 scheduled", "Nothing scheduled"]
        : [
            `${status.taken}/${status.total} taken`,
            `${status.taken} of ${status.total} taken`,
          ];
  const heading = [activeDay?.label, context?.label, title, currentContext]
    .filter(Boolean)
    .join(" ");
  const dayTestId = (day: (typeof days)[number]) =>
    day.date === today
      ? `${prefix}-day-today`
      : day.label === "Yesterday"
        ? `${prefix}-day-yesterday`
        : `${prefix}-day-${day.date}`;

  return (
    <div
      data-testid={food ? "food-log-context" : "intake-schedule-context"}
      className="mb-3 py-2 pr-1.5 md:sticky md:top-0 md:z-10 md:-mx-2 md:bg-surface/95 md:px-2 md:pr-2 md:backdrop-blur-sm lg:static lg:mx-0 lg:bg-transparent lg:p-0 lg:backdrop-filter-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          data-testid={`${prefix}-context-heading`}
          aria-label={heading}
          className="flex min-w-0 flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
        >
          <CompactDateMenu
            days={days}
            value={value}
            onChange={onChange}
            label={choose}
            testIdPrefix={prefix}
          />
          <span className="hidden sm:inline">{activeDay?.label}</span>
          {context && (
            <span
              data-testid={`${prefix}-context-label`}
              className="text-sm font-medium text-slate-500 dark:text-slate-400"
            >
              <span
                data-testid={`${prefix}-slot-chip`}
                data-slot={context.value}
                className="text-slate-500 dark:text-slate-400"
              >
                {context.label}
              </span>
            </span>
          )}
          {currentContext && (
            <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
              {currentContext}
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <p
            data-testid={food ? "food-day-total" : "supplements-status"}
            className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
          >
            {expandedStatus ? (
              <>
                <span
                  data-testid={`${prefix}s-status-mobile`}
                  className="sm:hidden"
                >
                  {compactStatus}
                </span>
                <span
                  data-testid={`${prefix}s-status-desktop`}
                  className="hidden sm:inline"
                >
                  {expandedStatus}
                </span>
              </>
            ) : (
              compactStatus
            )}
          </p>
          {action.kind === "food-preferences" ? (
            <span className="sm:hidden">
              <IconButton
                label="Dietary preferences"
                data-testid="food-preferences-open-mobile"
                onClick={action.onActivate}
              >
                <IconAdjustmentsHorizontal className="h-4 w-4" />
              </IconButton>
            </span>
          ) : (
            <AddSupplementModal {...action.modal} />
          )}
        </div>
      </div>
      <div className="mt-2 hidden min-w-0 overflow-x-auto pb-0.5 sm:block">
        <SegmentedControl
          options={days.map((day, daysAgo) => ({
            value: day.date,
            label: day.label,
            testId: dayTestId(day),
            dataAttributes: { "data-days-ago": daysAgo },
          }))}
          value={value}
          onChange={onChange}
          ariaLabel={group}
          testId={`${prefix}-day-toggle`}
          className="min-w-max"
        />
      </div>
    </div>
  );
}
