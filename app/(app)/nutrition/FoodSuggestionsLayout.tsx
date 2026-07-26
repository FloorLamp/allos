"use client";

import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { IconChevronDown, IconSparkles } from "@tabler/icons-react";
import type { FoodSlot } from "@/lib/food-slot";
import ModalShell from "@/components/ModalShell";
import InsightLauncher from "@/components/InsightLauncher";
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

// Context-only mount for the global quick-entry sheet. The full Nutrition page owns
// this state inside FoodSuggestionsLayout below, while the sheet needs the same
// logger state without the page's suggestions/sidebar composition.
export function FoodSelectedDateProvider({
  today,
  days,
  children,
}: {
  today: string;
  days: FoodLogDay[];
  children: ReactNode;
}) {
  const [activeDate, setActiveDate] = useState(today);
  const [countsByDate, setCountsByDate] = useState<CountsByDate>(() =>
    Object.fromEntries(days.map((day) => [day.date, day.counts]))
  );
  const [slotCountsByDate, setSlotCountsByDate] = useState<SlotCountsByDate>(
    () => Object.fromEntries(days.map((day) => [day.date, day.slotCounts]))
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
      {children}
    </FoodSelectedDateContext.Provider>
  );
}

function ResponsiveNutrientDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-testid="nutrition-nutrient-details">
      <button
        type="button"
        data-testid="nutrition-nutrient-details-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden lg:hidden dark:text-slate-200"
      >
        <span>Nutrient details</span>
        <IconChevronDown
          className={`h-4 w-4 text-slate-400 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div className={`${open ? "block" : "hidden"} pt-4 lg:block lg:pt-0`}>
        {children}
      </div>
    </div>
  );
}

// Owns the labs-driven suggestions disclosure. Its trigger follows the daily and
// weekly context in the unified right rail; the content opens in a modal so the
// logger and sidebar never reflow when the disclosure changes state.
export default function FoodSuggestionsLayout({
  today,
  days,
  logger,
  todaySidebar,
  weeklySidebar,
  selectedDayNutrients = [],
  suggestionContent,
  suggestionCount,
}: {
  today: string;
  days: FoodLogDay[];
  logger: ReactNode;
  todaySidebar: ReactNode;
  weeklySidebar: ReactNode;
  selectedDayNutrients?: { date: string; content: ReactNode }[];
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
  const activeDayNutrients = selectedDayNutrients.find(
    (item) => item.date === activeDate
  )?.content;

  const badge = (
    <InsightLauncher
      label="Lab suggestions"
      count={suggestionCount}
      icon={<IconSparkles className="h-3.5 w-3.5" />}
      tone="emerald"
      controls="nutrition-suggestions-panel"
      testId="nutrition-suggestions-summary"
      onClick={() => setOpen((current) => !current)}
    />
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
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {logger}
          <div data-testid="nutrition-sidebar" className="min-w-0 self-start">
            <div
              data-testid="nutrition-sidebar-surface"
              className="divide-y divide-black/5 overflow-hidden rounded-xl border border-black/10 bg-white/60 shadow-sm dark:divide-white/5 dark:border-white/10 dark:bg-ink-850/70"
            >
              {activeDate === today ? (
                todaySidebar && (
                  <div className="p-4">
                    <ResponsiveNutrientDetails>
                      {todaySidebar}
                    </ResponsiveNutrientDetails>
                  </div>
                )
              ) : activeDayNutrients ? (
                <div className="p-4">
                  <ResponsiveNutrientDetails>
                    <section data-testid="nutrition-selected-day-section">
                      <h2 className="mb-4 section-label">{activeDay?.label}</h2>
                      <div data-testid="selected-day-nutrients">
                        {activeDayNutrients}
                      </div>
                    </section>
                  </ResponsiveNutrientDetails>
                </div>
              ) : null}
              <div className="p-4">{weeklySidebar}</div>
              {hasSuggestions && (
                <section data-testid="nutrition-suggestions" className="p-4">
                  <h2 className="mb-3 section-label">Insights</h2>
                  {badge}
                </section>
              )}
            </div>
          </div>
        </div>

        {hasSuggestions && open && (
          <ModalShell
            title="Lab suggestions"
            onClose={() => setOpen(false)}
            className="flex max-h-[calc(100vh-2rem)] w-full max-w-4xl flex-col rounded-xl bg-white p-4 shadow-xl outline-none sm:p-5 dark:bg-ink-900"
          >
            <div
              id="nutrition-suggestions-panel"
              data-testid="nutrition-suggestions-panel"
              className="mt-4 min-h-0 overflow-y-auto pr-1"
            >
              {suggestionContent}
            </div>
          </ModalShell>
        )}
      </div>
    </FoodSelectedDateContext.Provider>
  );
}
