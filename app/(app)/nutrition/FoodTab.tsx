import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { getTimezone } from "@/lib/settings";
import { eatingTimeOptions as eatingTimeOptionsFor } from "@/lib/food-eating-time";
import { parseUtcSql, shiftDateStr, zonedMinuteStr } from "@/lib/date";
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
  getProteinDailyGrams,
  getProteinQuickAddPreset,
  getHabitualFoodGroups,
  getFiberSymptomPanel,
} from "@/lib/queries";
import { fiberSymptomPanelHasSignal } from "@/lib/fiber-symptom-panel";
import FiberSymptomPanel from "@/components/FiberSymptomPanel";
import { formatWeekdayDate } from "@/lib/format-date";
import {
  getProfileAge,
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
import FastingCard from "./FastingCard";
import {
  getActiveFastCached,
  getFastHistory,
  getServingsDuringFast,
} from "@/lib/queries/fasting";
import { fastingAvailable } from "@/lib/fast-write";
import {
  fastAttributedDay,
  fastElapsedMs,
  formatFastDuration,
} from "@/lib/fasting";
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

export default async function FoodTab({
  initialDate,
}: {
  initialDate?: string;
}) {
  const { login, profile } = await requireSession();
  const formatPrefs = getDisplayFormatPrefs(login.id);

  // Infant profiles (< 1 y) log milk/formula, not the adult food-group catalog, so
  // the serving logger is meaningless for them (issue #591). Show a calm note instead
  // of the logger; the nav entry is hidden by the same predicate, and this server-side
  // gate covers a direct URL. Eligible on unknown age (hide only on a positive match).
  if (!isFoodLoggingRelevant(getProfileAge(profile.id))) {
    // …but the CLOSE-OUT still renders, for the same reason the life-stage gate below
    // does not simply hide the card: an age edit can land on a profile with a fast
    // already running, and a gate whose escape hatch is never drawn leaves that row
    // permanently open with #2757's food nudges stood down behind it
    // (lib/fast-write.ts's end-side exemption). This gate sits one step EARLIER than the
    // fasting one, so returning here without it re-opened the same trap through a second
    // door. `canStart` is false and cannot be otherwise: a known age under one is a
    // known minor, which is the very line `fastingAvailable` draws.
    const infantFast = getActiveFastCached(profile.id);
    return (
      <div>
        {infantFast && (
          <FastingCard
            active={infantFast}
            canStart={false}
            history={[]}
            nowMs={clockNow().getTime()}
          />
        )}
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
  // The fasting surface's whole gather (#2756). The duration and day attribution are
  // formatted HERE, on the server, from the pure derivations: the day a completed fast
  // counts for is the day it ENDED (#94), and deriving it needs the profile timezone,
  // which the client does not have.
  //
  // WHO SEES WHAT, and why it is not simply `fastingAvailable`. A restricted profile
  // sees no fasting surface — EXCEPT the close-out control for a fast that is already
  // running. That exception is the whole point of the write core's end-side exemption
  // (lib/fast-write.ts): a birthdate edit mid-fast leaves an active row with both #2757
  // stand-downs on, and if the card is not rendered the user has an un-endable fast, a
  // silenced food nudge, and nothing on screen to act on — the exact stranded state the
  // exemption exists to prevent, reintroduced one layer up. So:
  //
  //   canStart true   — the full surface: start/end, the stale suggest, history.
  //   canStart false + an active fast — the close-out ONLY. No start, no history: this
  //                     is harm-reduction, not tracking, so it offers the way out and
  //                     nothing else.
  //   canStart false + no active fast — no card at all.
  const fastingTz = getTimezone(profile.id);
  const fastingNow = clockNow();
  const canStartFast = fastingAvailable(profile.id);
  const activeFastRow = getActiveFastCached(profile.id);
  const fasting =
    canStartFast || activeFastRow
      ? {
          active: activeFastRow,
          canStart: canStartFast,
          nowMs: fastingNow.getTime(),
          history: canStartFast
            ? getFastHistory(profile.id)
                .filter((f) => f.ended_at !== null)
                .map((f) => {
                  const day = fastAttributedDay(f, fastingTz);
                  // The correction form's prefill (#2993), as profile-local WALL times —
                  // resolved here because the server is the tier that knows the zone, the
                  // same discipline the backdate field already follows in the other
                  // direction (`parseBackdated` resolves the wall time the client sends).
                  // A client-side conversion would put a tab open across a zone change,
                  // or a browser with a skewed clock, in charge of what the user is shown
                  // their own history as.
                  const startedAt = parseUtcSql(f.started_at);
                  const endedAt = parseUtcSql(f.ended_at);
                  return {
                    fast: f,
                    day,
                    label: day
                      ? formatWeekdayDate(day, formatPrefs)
                      : "In progress",
                    duration: formatFastDuration(
                      fastElapsedMs(f, fastingNow) ?? 0
                    ),
                    startedLocal: startedAt
                      ? zonedMinuteStr(fastingTz, startedAt)
                      : "",
                    endedLocal: endedAt
                      ? zonedMinuteStr(fastingTz, endedAt)
                      : "",
                    servingsDuring: getServingsDuringFast(profile.id, f),
                  };
                })
            : [],
        }
      : null;
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
  // Fiber × GI symptoms on one axis (#2788) — a read-together VIEW, never a
  // correlation claim. The vocabulary and boundaries live in lib/fiber-symptom-panel.
  const fiberSymptomPanel = getFiberSymptomPanel(profile.id);
  // Direct protein-grams quick-add (#824): today's manual total + the last-used amount
  // (the repeated scoop size) to pre-fill the box. Protein powder's only home.
  const proteinLoggedGrams = getProteinDailyGrams(profile.id, date);
  const proteinPreset = getProteinQuickAddPreset(profile.id);
  // Current food slot (#950): the profile's wall-clock window (Morning/Midday/Evening)
  // in its timezone. Drives the slot-aware ranking AND the bar's slot chip — the SAME
  // derivation, so the label and the order can never disagree.
  const slot = currentFoodSlot(profile.id);
  // The "earlier…" hours the bar may state an eating time as (#2053), resolved SERVER-side
  // from the profile's timezone: each option carries the local wall time the chip shows,
  // the instant it means, and — #2269 — the meal window it files under, so the chip reads
  // `19:00 · Evening` and the bar can land the serving in its derived section without a
  // round-trip. The boundaries are the SAME ones the tallies use, so the chip's claim and
  // the section cannot disagree. Filtered to hours that still land on today, so a chip the
  // write would refuse is never on screen — and the bar only offers the affordance while
  // today is the selected day, because "now" is meaningless on a backfill and an unstated
  // log correctly records no eating time at all.
  const eatingTimeOptions = eatingTimeOptionsFor(
    clockNow(),
    getTimezone(profile.id),
    date,
    profileFoodSlotBoundaries(profile.id)
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
  // Food regularity (#2380): the groups this profile logs in each window nearly every
  // time that window is logged at all, over a bounded three-week span, with
  // cap-direction groups removed. An OBSERVATION, never a target — its only use is the
  // bar's "log my usual" shortcut, and a window under the declared gate is simply
  // absent here, which the bar renders as nothing rather than as a hedge.
  const usualBySlot = getHabitualFoodGroups(profile.id);
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
        initialDate={initialDate}
        suggestionCount={suggestions.length}
        logger={
          // Act: the one-tap log bar. On mobile this grid cell leads (bar → Today →
          // This week); on desktop it's the left column beside the sidebar.
          <div
            key="food-logger"
            data-testid="food-log-shell"
            className="min-w-0"
          >
            {/* Fasting (#2756) sits ABOVE the log bar because it is the same kind of
                thing — an act, in the "Act" column — and because the state chip has to
                be visible before the bar's taps start meeting "End your fast?".
                Rendered only for a profile the write core would accept a START from:
                hiding a surface is NOT the gate (lib/fast-write.ts refuses
                independently, which is what makes the gate real against a direct POST),
                it is simply not offering a control whose every tap would be refused. */}
            {fasting && (
              <FastingCard
                active={fasting.active}
                canStart={fasting.canStart}
                history={fasting.history}
                nowMs={fasting.nowMs}
              />
            )}
            <FoodLogBar
              today={date}
              days={mealDays}
              groupsBySlot={groupsBySlot}
              proteinRankBySlot={proteinRankBySlot}
              excludedGroups={excludedGroups}
              usualBySlot={usualBySlot}
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
            {/* Fiber × GI symptoms read together (#2788): rendered only when BOTH
                series have something in the window — with either empty there is
                nothing to co-read, and silence beats an empty exhortation. */}
            {fiberSymptomPanelHasSignal(fiberSymptomPanel) && (
              <FiberSymptomPanel
                panel={fiberSymptomPanel}
                formatPrefs={formatPrefs}
              />
            )}
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
