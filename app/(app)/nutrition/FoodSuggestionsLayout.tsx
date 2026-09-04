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
import { useActiveProfileId } from "@/components/ActiveProfileProvider";
import type { FoodSlot } from "@/lib/food-slot";
import ModalShell from "@/components/ModalShell";
import InsightLauncher from "@/components/InsightLauncher";
import type { FoodLogDay } from "./FoodLogBar";

type CountsByDate = Record<string, Record<string, number>>;
type SlotCountsByDate = Record<
  string,
  Record<FoodSlot, Record<string, number>>
>;

export interface FoodProjectionState {
  countsByDate: CountsByDate;
  slotCountsByDate: SlotCountsByDate;
}

interface FoodSelectedDateContextValue {
  activeDate: string;
  setActiveDate: Dispatch<SetStateAction<string>>;
  countsByDate: CountsByDate;
  slotCountsByDate: SlotCountsByDate;
  // Daily and per-meal counts are one projection. A correction moves one event
  // between two meal coordinates, so publishing them through separate provider
  // states permits a render to observe only half of the move.
  setProjection: Dispatch<SetStateAction<FoodProjectionState>>;
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
  ...props
}: FoodSelectedDateProviderProps) {
  const activeProfileId = useActiveProfileId();
  return (
    <FoodSelectedDateProviderForProfile
      key={activeProfileId ?? "unscoped"}
      {...props}
    />
  );
}

interface FoodSelectedDateProviderProps {
  today: string;
  days: FoodLogDay[];
  children: ReactNode;
}

function FoodSelectedDateProviderForProfile({
  today,
  days,
  children,
}: FoodSelectedDateProviderProps) {
  const [activeDate, setActiveDate] = useState(today);
  const [projection, setProjection] = useState<FoodProjectionState>(() => ({
    countsByDate: Object.fromEntries(days.map((day) => [day.date, day.counts])),
    slotCountsByDate: Object.fromEntries(
      days.map((day) => [day.date, day.slotCounts])
    ),
  }));

  return (
    <FoodSelectedDateContext.Provider
      value={{
        activeDate,
        setActiveDate,
        countsByDate: projection.countsByDate,
        slotCountsByDate: projection.slotCountsByDate,
        setProjection,
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
  ...props
}: FoodSuggestionsLayoutProps) {
  const activeProfileId = useActiveProfileId();
  return (
    <FoodSuggestionsLayoutForProfile
      key={activeProfileId ?? "unscoped"}
      {...props}
    />
  );
}

interface FoodSuggestionsLayoutProps {
  today: string;
  days: FoodLogDay[];
  initialDate?: string;
  logger: ReactNode;
  todaySidebar: ReactNode;
  weeklySidebar: ReactNode;
  selectedDayNutrients?: { date: string; content: ReactNode }[];
  suggestionContent: ReactNode;
  suggestionCount: number;
}

function FoodSuggestionsLayoutForProfile({
  today,
  days,
  initialDate,
  logger,
  todaySidebar,
  weeklySidebar,
  selectedDayNutrients = [],
  suggestionContent,
  suggestionCount,
}: FoodSuggestionsLayoutProps) {
  const [open, setOpen] = useState(false);
  const initialDateInRange =
    initialDate != null && days.some((day) => day.date === initialDate);
  const [activeDate, setActiveDate] = useState(
    initialDateInRange ? initialDate : today
  );
  const [projection, setProjection] = useState<FoodProjectionState>(() => ({
    countsByDate: Object.fromEntries(days.map((day) => [day.date, day.counts])),
    slotCountsByDate: Object.fromEntries(
      days.map((day) => [day.date, day.slotCounts])
    ),
  }));
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
        countsByDate: projection.countsByDate,
        slotCountsByDate: projection.slotCountsByDate,
        setProjection,
      }}
    >
      <div data-testid="nutrition-food-layout">
        {initialDate && !initialDateInRange ? (
          <p
            className="mb-4 text-sm text-slate-500 dark:text-slate-400"
            data-testid="food-date-bound-note"
          >
            Food backfill is available for today and the previous six days.
            Showing today.
          </p>
        ) : null}
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          {logger}
          <div data-testid="nutrition-sidebar" className="min-w-0 self-start">
            <div
              data-testid="nutrition-sidebar-surface"
              className="band divide-y divide-(--divider) overflow-hidden rounded-xl border border-(--border) bg-surface px-0! shadow-xs"
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
            size="lg"
          >
            <div
              id="nutrition-suggestions-panel"
              data-testid="nutrition-suggestions-panel"
              className="min-h-0 overflow-y-auto pr-1"
            >
              {suggestionContent}
            </div>
          </ModalShell>
        )}
      </div>
    </FoodSelectedDateContext.Provider>
  );
}
