"use client";

import { useState, type ReactNode } from "react";
import SegmentedControl from "@/components/SegmentedControl";
import CompactDateMenu from "@/components/CompactDateMenu";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";

type SlotSelection = "all" | TimeBucket;

export interface SupplementScheduleBucket {
  slot: TimeBucket;
  count: number;
  content: ReactNode;
}

export interface SupplementScheduleDay {
  date: string;
  label: string;
  totalCount: number;
  takenCount: number;
  buckets: SupplementScheduleBucket[];
}

// Local schedule lens for the Supplements workspace. It deliberately mirrors the
// Food logger's controls: seven recent days and large slot cards. The server renders
// each day's real schedule/status up front, so changing either lens is instant.
export default function SupplementSchedule({
  today,
  days,
  secondary,
  context,
  action,
}: {
  today: string;
  days: SupplementScheduleDay[];
  secondary?: ReactNode;
  context?: string | null;
  action?: ReactNode;
}) {
  const [activeDate, setActiveDate] = useState(today);
  const [slot, setSlot] = useState<SlotSelection>("all");
  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];
  const selected = activeDay.buckets.find((bucket) => bucket.slot === slot);
  const activeDayPhrase =
    activeDay.label === "Today" || activeDay.label === "Yesterday"
      ? activeDay.label.toLowerCase()
      : activeDay.label;
  const dayTestId = (day: SupplementScheduleDay) =>
    day.date === today
      ? "supplement-day-today"
      : day.label === "Yesterday"
        ? "supplement-day-yesterday"
        : `supplement-day-${day.date}`;
  const slotOptions: Array<{
    value: SlotSelection;
    label: string;
    count: number;
  }> = [
    { value: "all", label: "All", count: activeDay.totalCount },
    ...activeDay.buckets.map((bucket) => ({
      value: bucket.slot,
      label: TIME_BUCKET_LABELS[bucket.slot],
      count: bucket.count,
    })),
  ];

  return (
    <div data-testid="intake-schedule">
      <div
        data-testid="intake-schedule-context"
        className="-mx-2 mb-2 bg-white/95 px-2 py-1.5 md:sticky md:top-0 md:z-10 md:mb-3 md:py-2 md:backdrop-blur-sm lg:static lg:mx-0 lg:bg-transparent lg:p-0 dark:bg-ink-900/95 dark:lg:bg-transparent"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2
              data-testid="supplement-context-heading"
              aria-label={[
                activeDay.label,
                slot === "all" ? null : TIME_BUCKET_LABELS[slot],
                "Supplements",
                activeDate === today ? context : null,
              ]
                .filter(Boolean)
                .join(" ")}
              className="flex flex-wrap items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
            >
              <CompactDateMenu
                days={days}
                value={activeDate}
                onChange={setActiveDate}
                label="Choose day to review"
                testIdPrefix="supplement"
              />
              <span className="hidden sm:inline">{activeDay.label}</span>
              {slot !== "all" && (
                <span
                  data-testid="supplement-context-label"
                  className="text-sm font-medium text-slate-500 dark:text-slate-400"
                >
                  <span data-testid="supplement-slot-chip" data-slot={slot}>
                    {TIME_BUCKET_LABELS[slot]}
                  </span>
                </span>
              )}
              {activeDate === today && context && (
                <span className="text-sm font-medium text-slate-500 dark:text-slate-400">
                  {context}
                </span>
              )}
            </h2>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <p
              data-testid="supplements-status"
              className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
            >
              <span
                data-testid="supplements-status-mobile"
                className="sm:hidden"
              >
                {activeDay.totalCount === 0
                  ? "0 scheduled"
                  : `${activeDay.takenCount}/${activeDay.totalCount} taken`}
              </span>
              <span
                data-testid="supplements-status-desktop"
                className="hidden sm:inline"
              >
                {activeDay.totalCount === 0
                  ? "Nothing scheduled"
                  : `${activeDay.takenCount} of ${activeDay.totalCount} taken`}
              </span>
            </p>
            {action}
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
            value={activeDate}
            onChange={setActiveDate}
            ariaLabel="Day to review"
            testId="supplement-day-toggle"
            className="min-w-max"
          />
        </div>
      </div>

      <section className="mb-4">
        <h3 className="sr-only">Time slots</h3>
        <div
          data-testid="supplement-slot-selector"
          data-variant="large"
          role="group"
          aria-label="IntakeItem time slot"
          className="grid grid-cols-4 gap-1.5 sm:gap-2"
        >
          {slotOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              data-testid={`supplement-slot-${option.value
                .toLowerCase()
                .replaceAll(" ", "-")}`}
              aria-pressed={slot === option.value}
              onClick={() => setSlot(option.value)}
              className={`flex min-h-12 min-w-0 flex-col items-stretch justify-center rounded-lg border p-2 text-left transition sm:h-full sm:justify-start sm:p-2.5 ${
                slot === option.value
                  ? "border-brand-400 bg-white ring-1 ring-brand-200 dark:border-brand-600 dark:bg-ink-700 dark:ring-brand-900"
                  : "border-black/10 bg-white/60 hover:bg-white dark:border-white/10 dark:bg-ink-900/60 dark:hover:bg-ink-800"
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {option.label}
                </span>
                <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  {option.count}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <div data-testid="supplement-slot-panel">
        {slot === "all" ? (
          activeDay.totalCount > 0 ? (
            <div className="space-y-6">
              {activeDay.buckets
                .filter((bucket) => bucket.count > 0)
                .map((bucket) => bucket.content)}
            </div>
          ) : (
            <div
              data-testid="supplement-day-empty"
              className="rounded-xl border border-dashed border-black/10 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400"
            >
              Nothing scheduled for {activeDayPhrase}.
            </div>
          )
        ) : selected && selected.count > 0 ? (
          selected.content
        ) : (
          <div
            data-testid="supplement-slot-empty"
            className="rounded-xl border border-dashed border-black/10 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400"
          >
            Nothing scheduled for {TIME_BUCKET_LABELS[slot]}.
          </div>
        )}
      </div>

      {secondary && activeDate === today && (
        <div className="mt-6 space-y-4">{secondary}</div>
      )}
    </div>
  );
}
