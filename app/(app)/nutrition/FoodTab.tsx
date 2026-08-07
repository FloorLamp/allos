import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { getTimezone } from "@/lib/settings";
import { eatingTimeOptions as eatingTimeOptionsFor } from "@/lib/food-eating-time";
import { shiftDateStr } from "@/lib/date";
import {
  getFoodMealDays,
  getWeeklyFoodRollup,
  getFoodSuggestions,
  getFoodBarOrder,
  currentFoodSlot,
  getProteinAdequacy,
  getProteinOnDate,
  getProteinToday,
  getFiberAdequacy,
  getFiberOnDate,
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
import { profileFoodSlotBoundaries } from "@/lib/profile-food-slot";
import type { FoodGroup } from "@/lib/food-groups";
import {
  assessProteinAdequacy,
  proteinIntakeSummary,
  proteinTargetSummary,
  type ProteinAdequacy,
} from "@/lib/protein";
import {
  fiberBasisIsFloor,
  fiberIntakeSummary,
  fiberTargetSummary,
} from "@/lib/fiber";
import type { FiberAdequacy } from "@/lib/fiber";
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

const FIBER_STATUS_LABEL: Record<FiberAdequacy["status"], string> = {
  below: "Below",
  within: "In range",
  above: "Above",
};

const FIBER_STATUS_CLASS: Record<FiberAdequacy["status"], string> = {
  below: "text-amber-700 dark:text-amber-300",
  within: "text-emerald-700 dark:text-emerald-300",
  above: "text-slate-600 dark:text-slate-300",
};

function WeeklyFiberSummary({ adequacy }: { adequacy: FiberAdequacy }) {
  const { intake, target, status } = adequacy;
  const intakeValue = `${Math.round(intake.grams)}g${
    fiberBasisIsFloor(intake.basis) ? "+" : ""
  }`;

  return (
    <div
      data-testid="nutrition-weekly-fiber"
      aria-label="Weekly fiber average for logged days"
      className="border-t border-black/5 pt-5 dark:border-white/5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="section-label">Weekly fiber target</h3>
        <span
          data-testid="nutrition-weekly-fiber-status"
          className={`text-xs font-medium ${FIBER_STATUS_CLASS[status]}`}
        >
          {FIBER_STATUS_LABEL[status]}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
        <span>Avg logged day</span>
        <span className="inline-flex items-baseline gap-1 text-right tabular-nums">
          <span
            data-testid="nutrition-weekly-fiber-value"
            className="font-semibold text-slate-700 dark:text-slate-200"
          >
            {intakeValue}
          </span>
          <span>/ {Math.round(target.grams)}g+ goal</span>
        </span>
      </div>
    </div>
  );
}

function NutrientEstimateDetails({
  protein,
  fiber,
}: {
  protein: ProteinAdequacy | null;
  fiber: FiberAdequacy | null;
}) {
  return (
    <>
      {protein && (
        <div data-testid="protein-estimate-details">
          <p>
            <span className="font-medium">Protein intake: </span>
            <span data-testid="protein-intake">
              {proteinIntakeSummary(protein.intake)}
            </span>
          </p>
          <p className="mt-1">
            <span className="font-medium">Protein target: </span>
            <span data-testid="protein-target">
              {proteinTargetSummary(protein.target)}
            </span>
          </p>
        </div>
      )}
      {fiber && (
        <div data-testid="fiber-estimate-details">
          <p>
            <span className="font-medium">Fiber intake: </span>
            <span data-testid="fiber-intake">
              {fiberIntakeSummary(fiber.intake)}
            </span>
          </p>
          <p className="mt-1">
            <span className="font-medium">Fiber target: </span>
            <span data-testid="fiber-target">
              {fiberTargetSummary(fiber.target)}
            </span>
          </p>
        </div>
      )}
    </>
  );
}

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
  // with a supplemented basis. This is the current week's average LOGGED day, retained
  // for the explicitly weekly section and the coaching finding.
  const fiberAdequacy = getFiberAdequacy(profile.id);
  // The selected Today context needs an actual calendar-day value, not the weekly
  // coaching average. Previous picker days already use this same date-scoped gather.
  const fiberToday = getFiberOnDate(profile.id, date);
  // Direct protein-grams quick-add (#824): today's manual total + the last-used amount
  // (the repeated scoop size) to pre-fill the box. Protein powder's only home.
  const proteinLoggedGrams = getProteinLoggedGrams(profile.id, date);
  const proteinPreset = getProteinQuickAddPreset(profile.id);
  // Current food slot (#950): the profile's wall-clock window (Morning/Midday/Evening)
  // in its timezone. Drives the slot-aware ranking AND the bar's slot chip — the SAME
  // derivation, so the label and the order can never disagree.
  const slot = currentFoodSlot(profile.id);
  // The "earlier…" hours the bar may state an eating time as (#2053), resolved SERVER-side
  // from the profile's timezone: each option carries both the local wall time the chip
  // shows and the instant it means, so the browser never converts a profile-local hour
  // with its own locale and an offline capture has a real instant to carry into replay.
  // Filtered to hours that still land on today, so a chip the write would refuse is never
  // on screen — and the bar only offers the affordance while today is the selected day,
  // because "now" is meaningless on a backfill and an unstated log correctly records no
  // eating time at all.
  const eatingTimeOptions = eatingTimeOptionsFor(
    clockNow(),
    getTimezone(profile.id),
    date
  );
  // One learned order per meal, from THE ranking both surfaces read (#1980). Switching
  // the selected slot on the client changes both the button counts and the ordering
  // without a round-trip. `proteinRank` is where the reserved protein pseudo-entry placed
  // in that meal's order (null when the profile doesn't track protein yet).
  const orderBySlot = Object.fromEntries(
    FOOD_SLOTS.map((meal) => [meal, getFoodBarOrder(profile.id, meal)])
  ) as Record<FoodSlot, ReturnType<typeof getFoodBarOrder>>;
  const groupsBySlot = Object.fromEntries(
    FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].groups])
  ) as Record<FoodSlot, FoodGroup[]>;
  const proteinRankBySlot = Object.fromEntries(
    FOOD_SLOTS.map((meal) => [meal, orderBySlot[meal].proteinRank])
  ) as Record<FoodSlot, number | null>;
  // Preference legibility (#980 item 4): a muted "showing <pattern>-friendly sources" note
  // for the suggestions summary, so #975's demote/substitute is explicable on-surface.
  // Null (no chrome) when no preference is set. Editing stays on the profile-settings
  // surface that owns the full preset + exclusion form.
  const excludedGroups = getExcludedFoodGroups(profile.id);
  const preferenceNote = preferenceSuggestionNote(excludedGroups);

  // The recent-day picker is a historical editor, so its feedback must follow the
  // selected date too. Protein retains its today+weekly comparison model; fiber uses a
  // true single-day estimate for EVERY selected date, including Today.
  const nutrientDays = mealDays.map((day) => {
    const isToday = day.date === date;
    const protein = isToday
      ? proteinToday
      : getProteinOnDate(profile.id, day.date);
    const proteinAssessment = isToday
      ? proteinAdequacy
      : protein?.todayIntake
        ? assessProteinAdequacy(protein.todayIntake, protein.target)
        : null;
    const fiber = isToday ? fiberToday : getFiberOnDate(profile.id, day.date);
    const sentencePeriod =
      day.label === "Today"
        ? "today"
        : day.label === "Yesterday"
          ? "yesterday"
          : `on ${day.label}`;

    return {
      ...day,
      protein,
      proteinAssessment,
      fiber,
      sentencePeriod,
    };
  });
  const mobileNutrients = nutrientDays
    .filter((day) => day.protein || day.proteinAssessment || day.fiber)
    .map((day) => ({
      date: day.date,
      content: (
        <NutritionSnapshot
          key={day.date}
          proteinToday={day.protein}
          proteinAdequacy={day.proteinAssessment}
          fiberAdequacy={day.fiber}
          proteinPeriod={day.sentencePeriod}
          fiberPeriod={day.sentencePeriod}
        />
      ),
    }));
  const selectedDayNutrients = nutrientDays
    .filter(
      (day) =>
        day.date !== date && (day.protein || day.proteinAssessment || day.fiber)
    )
    .map((day) => ({
      date: day.date,
      content: (
        <NutrientsCard
          key={day.date}
          embedded
          title="Nutrients"
          headingLevel={3}
          details={
            <NutrientEstimateDetails
              protein={day.proteinAssessment}
              fiber={day.fiber}
            />
          }
        >
          {(day.protein || day.proteinAssessment) && (
            <ProteinAdequacyCard
              today={day.protein}
              adequacy={day.proteinAssessment}
              periodLabel={day.label}
            />
          )}
          {day.fiber && (
            <FiberAdequacyCard adequacy={day.fiber} periodLabel={day.label} />
          )}
        </NutrientsCard>
      ),
    }));

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
            key="food-logger"
            data-testid="food-log-shell"
            className="min-w-0"
          >
            <FoodLogBar
              today={date}
              days={mealDays}
              groupsBySlot={groupsBySlot}
              proteinRankBySlot={proteinRankBySlot}
              excludedGroups={excludedGroups}
              slot={slot}
              // The same boundaries the tallies derive windows from, so the correction
              // sheet's follow-the-hour Meal default (#2227 d4) can never disagree with
              // the window the server will count the corrected serving in.
              slotBoundaries={profileFoodSlotBoundaries(profile.id)}
              eatingTimeOptions={eatingTimeOptions}
              nutrientSummaryByDate={mobileNutrients}
              proteinQuickAdd={
                <ProteinQuickAdd
                  key="protein-quickadd"
                  today={date}
                  initialGrams={proteinLoggedGrams}
                  lastPreset={proteinPreset}
                />
              }
            />
          </div>
        }
        selectedDayNutrients={selectedDayNutrients}
        suggestionContent={
          <div key="food-suggestions">
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
          </div>
        }
        todaySidebar={
          // Today's feedback — the nutrients card, pairing with the log bar's #950
          // slot chip. The client layout swaps this out for a selected-day meal
          // summary while backfilling an older date.
          (proteinToday || proteinAdequacy || fiberToday) && (
            <section
              key="nutrition-today"
              data-testid="nutrition-today-section"
            >
              <NutrientsCard
                embedded
                details={
                  <NutrientEstimateDetails
                    protein={proteinAdequacy}
                    fiber={fiberToday}
                  />
                }
              >
                {(proteinToday || proteinAdequacy) && (
                  <ProteinAdequacyCard
                    today={proteinToday}
                    adequacy={proteinAdequacy}
                  />
                )}
                {fiberToday && (
                  <FiberAdequacyCard
                    adequacy={fiberToday}
                    periodLabel="Today"
                  />
                )}
              </NutrientsCard>
            </section>
          )
        }
        weeklySidebar={
          // Weekly reflection remains visible for every selected date because it is
          // explicitly labeled as a weekly context rather than a daily one.
          <section
            key="nutrition-week"
            data-testid="nutrition-week-section"
            className="space-y-5"
          >
            <div>
              <h2 className="mb-3 section-label">This week</h2>
              <FoodWeeklyRollup rollup={rollup} />
            </div>
            {fiberAdequacy && <WeeklyFiberSummary adequacy={fiberAdequacy} />}
            <div className="border-t border-black/5 pt-5 dark:border-white/5">
              <WeeklyHabits
                profileId={profile.id}
                formatPrefs={formatPrefs}
                embedded
              />
            </div>
          </section>
        }
      />
    </div>
  );
}
