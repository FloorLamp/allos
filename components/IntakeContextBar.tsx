"use client";

import type { ReactNode } from "react";
import CompactDateMenu from "@/components/CompactDateMenu";
import SegmentedControl from "@/components/SegmentedControl";

// THE DAY TAB'S HEADER (#3987). One surface's chrome, not two: the Supplements
// tab's day switcher retired with its schedule in phase 1, and the dietary
// preferences affordance left this bar in phase 2 — preferences are configuration,
// so they live on Manage beside the stack rather than as an icon on the day.
// What is left is the day itself: which day, what it holds, and the door to the
// record (#3671 — mounted where the log is, not in a rail that stacks to the
// bottom of the page below `lg`).
export default function IntakeContextBar({
  today,
  days,
  value,
  onChange,
  context,
  ledgerDoor,
  servings,
}: {
  today: string;
  days: readonly { date: string; label: string }[];
  value: string;
  onChange: (date: string) => void;
  context?: { label: string; value?: string };
  ledgerDoor?: ReactNode;
  servings: number;
}) {
  const activeDay = days.find((day) => day.date === value) ?? days[0];
  const heading = [activeDay?.label, context?.label, "Food Log"]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      data-testid="food-log-context"
      className="mb-3 py-2 pr-1.5 md:sticky md:top-0 md:z-10 md:-mx-2 md:bg-surface/95 md:px-2 md:pr-2 md:backdrop-blur-sm lg:static lg:mx-0 lg:bg-transparent lg:p-0 lg:backdrop-filter-none"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          data-testid="food-context-heading"
          aria-label={heading}
          className="flex min-w-0 flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
        >
          <CompactDateMenu
            days={days}
            value={value}
            onChange={onChange}
            label="Choose day to log"
            testIdPrefix="food"
          />
          <span className="hidden sm:inline">{activeDay?.label}</span>
          {context && (
            <span
              data-testid="food-context-label"
              className="text-sm font-medium text-slate-500 dark:text-slate-400"
            >
              <span
                data-testid="food-slot-chip"
                data-slot={context.value}
                className="text-slate-500 dark:text-slate-400"
              >
                {context.label}
              </span>
            </span>
          )}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          {ledgerDoor}
          <p
            data-testid="food-day-total"
            className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
          >
            {servings} {servings === 1 ? "serving" : "servings"}
          </p>
        </div>
      </div>
      <div className="mt-2 hidden min-w-0 overflow-x-auto pb-0.5 sm:block">
        <SegmentedControl
          options={days.map((day, daysAgo) => ({
            value: day.date,
            label: day.label,
            testId:
              day.date === today
                ? "food-day-today"
                : day.label === "Yesterday"
                  ? "food-day-yesterday"
                  : `food-day-${day.date}`,
            dataAttributes: { "data-days-ago": daysAgo },
          }))}
          value={value}
          onChange={onChange}
          ariaLabel="Day to log"
          testId="food-day-toggle"
          className="min-w-max"
        />
      </div>
    </div>
  );
}
