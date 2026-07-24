"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { IconChevronDown, IconSalad } from "@tabler/icons-react";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import type { FoodLogDay } from "./FoodLogBar";

type CountsByDate = Record<string, Record<string, number>>;
type SlotCountsByDate = Record<
  string,
  Record<FoodSlot, Record<string, number>>
>;

interface FoodSelectedDateContextValue {
  activeDate: string;
  setActiveDate: Dispatch<SetStateAction<string>>;
  countsByDate: CountsByDate;
  setCountsByDate: Dispatch<SetStateAction<CountsByDate>>;
  slotCountsByDate: SlotCountsByDate;
  setSlotCountsByDate: Dispatch<SetStateAction<SlotCountsByDate>>;
}

const FoodSelectedDateContext =
  createContext<FoodSelectedDateContextValue | null>(null);

export function useFoodSelectedDate(): FoodSelectedDateContextValue {
  const value = useContext(FoodSelectedDateContext);
  if (!value) {
    throw new Error(
      "useFoodSelectedDate must be used inside FoodSuggestionsLayout"
    );
  }
  return value;
}

// Owns the responsive placement of the labs-driven suggestions disclosure.
// Collapsed, it is a small badge at the top of the right column. Open, the content
// spans the full Nutrition reading width above the two-column logger/sidebar grid.
export default function FoodSuggestionsLayout({
  today,
  days,
  logger,
  todaySidebar,
  weeklySidebar,
  suggestionContent,
  suggestionCount,
}: {
  today: string;
  days: FoodLogDay[];
  logger: ReactNode;
  todaySidebar: ReactNode;
  weeklySidebar: ReactNode;
  suggestionContent: ReactNode;
  suggestionCount: number;
}) {
  const [open, setOpen] = useState(false);
  const [activeDate, setActiveDate] = useState(today);
  const [countsByDate, setCountsByDate] = useState<CountsByDate>(() =>
    Object.fromEntries(days.map((day) => [day.date, day.counts]))
  );
  const [slotCountsByDate, setSlotCountsByDate] = useState<SlotCountsByDate>(
    () => Object.fromEntries(days.map((day) => [day.date, day.slotCounts]))
  );
  const hasSuggestions = suggestionCount > 0;
  const activeDay = days.find((day) => day.date === activeDate) ?? days[0];
  const dayTotal = Object.values(countsByDate[activeDate] ?? {}).reduce(
    (sum, count) => sum + count,
    0
  );
  const slotTotals = Object.fromEntries(
    FOOD_SLOTS.map((slot) => [
      slot,
      Object.values(slotCountsByDate[activeDate]?.[slot] ?? {}).reduce(
        (sum, count) => sum + count,
        0
      ),
    ])
  ) as Record<(typeof FOOD_SLOTS)[number], number>;
  const assignedTotal = Object.values(slotTotals).reduce(
    (sum, count) => sum + count,
    0
  );
  const unassignedTotal = Math.max(0, dayTotal - assignedTotal);

  const badge = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="nutrition-suggestions-panel"
      data-testid="nutrition-suggestions-summary"
      onClick={() => setOpen((current) => !current)}
      className="ml-auto flex w-fit cursor-pointer items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50/80 px-2.5 py-1.5 text-xs font-medium text-emerald-800 outline-none transition hover:bg-emerald-100 focus-visible:ring-2 focus-visible:ring-emerald-500/40 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:bg-emerald-950/70"
    >
      <IconSalad className="h-3.5 w-3.5 shrink-0" />
      <span>Lab suggestions</span>
      <span className="rounded-full bg-emerald-100 px-1.5 text-xs tabular-nums text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
        {suggestionCount}
      </span>
      <IconChevronDown
        className={`h-3.5 w-3.5 shrink-0 transition-transform ${
          open ? "rotate-180" : ""
        }`}
      />
    </button>
  );

  return (
    <FoodSelectedDateContext.Provider
      value={{
        activeDate,
        setActiveDate,
        countsByDate,
        setCountsByDate,
        slotCountsByDate,
        setSlotCountsByDate,
      }}
    >
      <div data-testid="nutrition-food-layout">
        {hasSuggestions && open && (
          <div data-testid="nutrition-suggestions" className="mb-6 min-w-0">
            {badge}
            <div
              id="nutrition-suggestions-panel"
              data-testid="nutrition-suggestions-panel"
              className="mt-3 w-full"
            >
              {suggestionContent}
            </div>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {logger}
          <div
            data-testid="nutrition-sidebar"
            className="min-w-0 space-y-6 self-start"
          >
            {hasSuggestions && !open && (
              <div data-testid="nutrition-suggestions">{badge}</div>
            )}
            {activeDate === today ? (
              todaySidebar
            ) : (
              <section
                data-testid="nutrition-selected-day-section"
                className="space-y-3"
              >
                <h2 className="section-label">{activeDay?.label}</h2>
                <div className="card">
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                      Meals
                    </h3>
                    <span className="text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400">
                      {dayTotal} {dayTotal === 1 ? "serving" : "servings"}
                    </span>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    {FOOD_SLOTS.map((slot) => (
                      <div
                        key={slot}
                        data-testid={`selected-day-slot-${slot.toLowerCase()}`}
                        className="rounded-lg bg-slate-50 px-2 py-2 dark:bg-ink-850"
                      >
                        <dt className="text-xs text-slate-500 dark:text-slate-400">
                          {slot}
                        </dt>
                        <dd className="mt-0.5 font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                          {slotTotals[slot]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {unassignedTotal > 0 && (
                    <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                      {unassignedTotal} older{" "}
                      {unassignedTotal === 1 ? "serving has" : "servings have"}{" "}
                      no meal assignment.
                    </p>
                  )}
                </div>
              </section>
            )}
            {weeklySidebar}
          </div>
        </div>
      </div>
    </FoodSelectedDateContext.Provider>
  );
}
