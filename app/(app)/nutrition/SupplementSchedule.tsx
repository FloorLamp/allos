"use client";

import { useState, type ReactNode } from "react";
import IntakeContextBar from "@/components/IntakeContextBar";
import { EmptyState } from "@/components/ui";
import AddSupplementModal, {
  type AddSupplementModalProps,
} from "@/components/nutrition/AddSupplementModal";
import { TIME_BUCKET_LABELS, type TimeBucket } from "@/lib/intake-schedule";

type SlotSelection = "all" | TimeBucket;

export interface SupplementScheduleDay {
  date: string;
  label: string;
  totalCount: number;
  takenCount: number;
  buckets: { slot: TimeBucket; count: number; content: ReactNode }[];
}

export default function SupplementSchedule({
  today,
  days,
  secondary,
  context,
  addSupplement,
}: {
  today: string;
  days: SupplementScheduleDay[];
  secondary?: ReactNode;
  context?: string | null;
  addSupplement: AddSupplementModalProps;
}) {
  const [activeDate, setActiveDate] = useState(today);
  const [slot, setSlot] = useState<SlotSelection>("all");
  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];
  const selected = activeDay.buckets.find((bucket) => bucket.slot === slot);
  const activeDayPhrase =
    activeDay.label === "Today" || activeDay.label === "Yesterday"
      ? activeDay.label.toLowerCase()
      : activeDay.label;
  const slotOptions = [
    { value: "all" as const, label: "All", count: activeDay.totalCount },
    ...activeDay.buckets.map((bucket) => ({
      value: bucket.slot,
      label: TIME_BUCKET_LABELS[bucket.slot],
      count: bucket.count,
    })),
  ];

  return (
    <div data-testid="intake-schedule">
      <IntakeContextBar
        purpose="supplement-review"
        today={today}
        days={days}
        value={activeDate}
        onChange={setActiveDate}
        context={
          slot === "all"
            ? undefined
            : { label: TIME_BUCKET_LABELS[slot], value: slot }
        }
        todayContext={context}
        status={{
          kind: "taken",
          taken: activeDay.takenCount,
          total: activeDay.totalCount,
        }}
        createAction={{
          kind: "supplement",
          control: <AddSupplementModal {...addSupplement} />,
        }}
      />

      <section className="mb-4">
        <h3 className="sr-only">Time slots</h3>
        <div
          data-testid="supplement-slot-selector"
          data-variant="large"
          role="group"
          aria-label="Supplement time slot"
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
                  ? "border-brand-400 bg-surface ring-1 ring-brand-200 dark:border-brand-600 dark:ring-brand-900"
                  : "border-(--border) bg-(--ghost) hover:bg-(--ghost-hover)"
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
            <EmptyState
              compact
              testId="supplement-day-empty"
              message={`Nothing scheduled for ${activeDayPhrase}.`}
            />
          )
        ) : selected && selected.count > 0 ? (
          selected.content
        ) : (
          <EmptyState
            compact
            testId="supplement-slot-empty"
            message={`Nothing scheduled for ${TIME_BUCKET_LABELS[slot]}.`}
          />
        )}
      </div>

      {secondary && activeDate === today && (
        <div className="mt-6 space-y-4">{secondary}</div>
      )}
    </div>
  );
}
