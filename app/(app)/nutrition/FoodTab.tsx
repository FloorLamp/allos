import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getFoodMealDays,
  getWeeklyFoodRollup,
  getFoodSuggestions,
  getFoodGroupLogOrder,
  currentFoodSlot,
  getProteinAdequacy,
  getProteinToday,
  getFiberAdequacy,
  getProteinLoggedGrams,
  getProteinQuickAddPreset,
} from "@/lib/queries";
import { formatWeekdayDate } from "@/lib/format-date";
import {
  getUserAge,
  getExcludedFoodGroups,
} from "@/lib/settings/profile-attrs";
import { preferenceSuggestionNote } from "@/lib/dietary-preferences";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { FOOD_SLOTS, type FoodSlot } from "@/lib/food-slot";
import { EmptyState } from "@/components/ui";
import FoodLogBar, { type FoodLogDay } from "./FoodLogBar";
import ProteinQuickAdd from "./ProteinQuickAdd";
import WeeklyHabits from "./WeeklyHabits";
import { trackFoodHabit } from "./actions";
import FoodWeeklyRollup from "@/components/FoodWeeklyRollup";
import FoodSuggestions from "@/components/FoodSuggestions";
import NutrientsCard from "@/components/NutrientsCard";
import ProteinAdequacyCard from "@/components/ProteinAdequacyCard";
import FiberAdequacyCard from "@/components/FiberAdequacyCard";
import NutritionSnapshot from "./NutritionSnapshot";
import FoodSuggestionsLayout from "./FoodSuggestionsLayout";

// The Food tab of the Nutrition umbrella (#746): the food-group serving log (issue
// #579) — the INPUT half of nutrition.
// One-tap serving logging for today + a weekly rollup, plus the deterministic
// biomarker→food suggestions (#577) shown here as "food before pills." Habit tier,
// informational — never a calorie counter.

export default async function FoodTab() {
  const { login, profile } = await requireSession();
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // Infant profiles (< 1 y) log milk/formula, not the adult food-group catalog, so
  // the serving logger is meaningless for them (issue #591). Show a calm note instead
  // of the logger; the nav entry is hidden by the same predicate, and this server-side
  // gate covers a direct URL. Eligible on unknown age (hide only on a positive match).
  if (!isFoodLoggingRelevant(getUserAge(profile.id))) {
    return (
      <div>
        <p className="mb-4 text-sm text-slate-500 dark:text-slate-400">
          Food-group serving logging starts after the first year.
        </p>
        <div className="card" data-testid="nutrition-infant-note">
          <EmptyState message="This profile is under one year old. The food-group serving log covers the adult habit catalog (leafy greens, whole grains, and so on) — infant feeding isn't tracked here. Growth for this age lives in the Body and Timeline views." />
        </div>
      </div>
    );
  }

  const date = today(profile.id);
  // A deliberately bounded recent-meal picker: today plus the previous six days.
  // This is enough to recover a missed meal without turning the one-tap habit log into
  // an unrestricted historical editor. Each day's daily counters and meal-slot ledger
  // arrive together, so changing day/meal is instant on the client.
  const recentDates = Array.from({ length: 7 }, (_, i) =>
    shiftDateStr(date, -i)
  );
  const mealDays: FoodLogDay[] = getFoodMealDays(profile.id, recentDates).map(
    (day, i) => ({
      ...day,
      label:
        i === 0
          ? "Today"
          : i === 1
            ? "Yesterday"
            : formatWeekdayDate(day.date, formatPrefs),
    })
  );
  const rollup = getWeeklyFoodRollup(profile.id);
  const suggestions = getFoodSuggestions(profile.id);
  // Goal-scaled protein adequacy (#767): the ONE gather the coaching finding also reads.
  // Null when there's no intake signal or no bodyweight to scale a target by.
  const proteinAdequacy = getProteinAdequacy(profile.id);
  // The band-gauge model (#974): today so far + weekly average + goal band. Null when
  // there's no bodyweight target or no protein data at all.
  const proteinToday = getProteinToday(profile.id);
  // Fiber adequacy (#976): the DRI-scaled fiber verdict, the protein pipeline mirrored
  // with a supplemented basis. Null when there's no intake signal or no DRI target.
  const fiberAdequacy = getFiberAdequacy(profile.id);
  // Direct protein-grams quick-add (#824): today's manual total + the last-used amount
  // (the repeated scoop size) to pre-fill the box. Protein powder's only home.
  const proteinLoggedGrams = getProteinLoggedGrams(profile.id, date);
  const proteinPreset = getProteinQuickAddPreset(profile.id);
  // Current food slot (#950): the profile's wall-clock window (Morning/Midday/Evening)
  // in its timezone. Drives the slot-aware ranking AND the bar's slot chip — the SAME
  // derivation, so the label and the order can never disagree.
  const slot = currentFoodSlot(profile.id);
  // One learned order per meal. Switching the selected slot on the client changes both
  // the button counts and the ordering without a round-trip.
  const groupsBySlot = Object.fromEntries(
    FOOD_SLOTS.map((meal) => [meal, getFoodGroupLogOrder(profile.id, meal)])
  ) as Record<FoodSlot, ReturnType<typeof getFoodGroupLogOrder>>;
  // Preference legibility (#980 item 4): a muted "showing <pattern>-friendly sources" note
  // for the suggestions summary, so #975's demote/substitute is explicable on-surface.
  // Null (no chrome) when no preference is set. Editing stays on the profile-settings
  // surface that owns the full preset + exclusion form.
  const excludedGroups = getExcludedFoodGroups(profile.id);
  const preferenceNote = preferenceSuggestionNote(excludedGroups);

  return (
    <div>
      {/* min-w-0 on both grid cells: a grid item defaults to min-width:auto
          (min-content), so the single mobile column would otherwise grow to the
          widest row's intrinsic width and overflow — <main>'s overflow-x-clip
          then silently clips the +/- log controls off the right edge. min-w-0
      lets the column shrink to the viewport so each card's own
      truncate/flex handling takes over. */}
      <FoodSuggestionsLayout
        today={date}
        days={mealDays}
        suggestionCount={suggestions.length}
        logger={
          // Act: the one-tap log bar. On mobile this grid cell leads (bar → Today →
          // This week); on desktop it's the left column beside the sidebar.
          <div
            data-testid="food-log-shell"
            className="min-w-0 lg:rounded-xl lg:border lg:border-white/60 lg:bg-white/55 lg:p-5 lg:shadow-lg lg:shadow-slate-300/40 lg:backdrop-blur-2xl lg:backdrop-saturate-150 dark:lg:border-white/10 dark:lg:bg-ink-800/45 dark:lg:shadow-black/30"
          >
            <FoodLogBar
              today={date}
              days={mealDays}
              groupsBySlot={groupsBySlot}
              excludedGroups={excludedGroups}
              slot={slot}
              afterQuick={
                <NutritionSnapshot
                  proteinToday={proteinToday}
                  proteinAdequacy={proteinAdequacy}
                  fiberAdequacy={fiberAdequacy}
                />
              }
            />
          </div>
        }
        suggestionContent={
          <>
            {preferenceNote && (
              <p
                data-testid="suggestions-preference-note"
                className="mb-2 px-1 text-sm text-slate-500 dark:text-slate-400"
              >
                {preferenceNote}
              </p>
            )}
            <FoodSuggestions
              suggestions={suggestions}
              trackAction={async (fd) => {
                "use server";
                await trackFoodHabit(fd);
              }}
            />
          </>
        }
        todaySidebar={
          // Today's feedback — the nutrients card, pairing with the log bar's #950
          // slot chip. The client layout swaps this out for a selected-day meal
          // summary while backfilling an older date.
          (proteinToday || proteinAdequacy || fiberAdequacy) && (
            <section
              data-testid="nutrition-today-section"
              className="space-y-3"
            >
              <h2 className="section-label">Today</h2>
              <NutrientsCard>
                {(proteinToday || proteinAdequacy) && (
                  <ProteinAdequacyCard
                    today={proteinToday}
                    adequacy={proteinAdequacy}
                    quickAdd={
                      <ProteinQuickAdd
                        today={date}
                        initialGrams={proteinLoggedGrams}
                        lastPreset={proteinPreset}
                      />
                    }
                  />
                )}
                {fiberAdequacy && (
                  <FiberAdequacyCard adequacy={fiberAdequacy} />
                )}
              </NutrientsCard>
            </section>
          )
        }
        weeklySidebar={
          // Weekly reflection remains visible for every selected date because it is
          // explicitly labeled as a weekly context rather than a daily one.
          <section data-testid="nutrition-week-section" className="space-y-3">
            <h2 className="section-label">This week</h2>
            <div className="card">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Servings
              </h3>
              <FoodWeeklyRollup rollup={rollup} />
            </div>
            <WeeklyHabits profileId={profile.id} formatPrefs={formatPrefs} />
          </section>
        }
      />
    </div>
  );
}
