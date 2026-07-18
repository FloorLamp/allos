import Link from "next/link";
import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  getFoodServingsOnDate,
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
import {
  getUserAge,
  getExcludedFoodGroups,
} from "@/lib/settings/profile-attrs";
import { preferenceSuggestionNote } from "@/lib/dietary-preferences";
import { isFoodLoggingRelevant } from "@/lib/life-stage";
import { EmptyState } from "@/components/ui";
import FoodLogBar from "./FoodLogBar";
import ProteinQuickAdd from "./ProteinQuickAdd";
import WeeklyHabits from "./WeeklyHabits";
import { trackFoodHabit } from "./actions";
import FoodWeeklyRollup from "@/components/FoodWeeklyRollup";
import FoodSuggestions from "@/components/FoodSuggestions";
import NutrientsCard from "@/components/NutrientsCard";
import ProteinAdequacyCard from "@/components/ProteinAdequacyCard";
import FiberAdequacyCard from "@/components/FiberAdequacyCard";

// The Food tab of the Nutrition umbrella (#746): the food-group serving log (issue
// #579) — the INPUT half of nutrition.
// One-tap serving logging for today + a weekly rollup, plus the deterministic
// biomarker→food suggestions (#577) shown here as "food before pills." Habit tier,
// informational — never a calorie counter.

export default async function FoodTab() {
  const { profile } = await requireSession();

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
  // Yesterday is loggable too (#748 item 1) — the honest "forgot to log at dinner"
  // backfill. Deliberately today/yesterday only: a full date picker invites
  // retro-fabricating streaks. Both days' current servings are loaded so the toggle
  // shows the right counts without a round-trip.
  const yesterday = shiftDateStr(date, -1);
  const initial: Record<string, number> = {};
  for (const [slug, n] of getFoodServingsOnDate(profile.id, date))
    initial[slug] = n;
  const initialYesterday: Record<string, number> = {};
  for (const [slug, n] of getFoodServingsOnDate(profile.id, yesterday))
    initialYesterday[slug] = n;
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
  // Catalog pre-ordered so the profile's staples lead within each tier (#591), now
  // slot-aware so the current window's staples lead (fish at lunch, #950).
  const groups = getFoodGroupLogOrder(profile.id, slot);
  // Preference legibility (#980 item 4): a muted "showing <pattern>-friendly sources" note
  // for the suggestions summary, so #975's demote/substitute is explicable on-surface.
  // Null (no chrome) when no preference is set. The link at the log bar's foot below points
  // at where you set them.
  const preferenceNote = preferenceSuggestionNote(
    getExcludedFoodGroups(profile.id)
  );

  return (
    <div>
      {suggestions.length > 0 && (
        // Collapsed by default (#591): the labs-driven suggestions used to push the
        // logger below the fold on every visit. A native <details> keeps it one
        // compact line until the user opens it. The container keeps the
        // nutrition-suggestions testid; the biomarker-detail surface stays as-is.
        <details
          data-testid="nutrition-suggestions"
          className="card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
        >
          <summary
            data-testid="nutrition-suggestions-summary"
            className="flex cursor-pointer list-none items-center gap-2 font-semibold text-slate-800 dark:text-slate-100"
          >
            <span className="flex-1">
              Food suggestions from your labs
              <span className="ml-1.5 font-normal text-slate-500 dark:text-slate-400">
                · {suggestions.length}
              </span>
              {preferenceNote && (
                <span
                  data-testid="suggestions-preference-note"
                  className="ml-1.5 font-normal italic text-slate-500 dark:text-slate-400"
                >
                  · {preferenceNote}
                </span>
              )}
            </span>
            <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
              Show
            </span>
          </summary>
          <div className="mt-3">
            <FoodSuggestions
              suggestions={suggestions}
              trackAction={async (fd) => {
                "use server";
                await trackFoodHabit(fd);
              }}
            />
          </div>
        </details>
      )}

      {/* min-w-0 on both grid cells: a grid item defaults to min-width:auto
          (min-content), so the single mobile column would otherwise grow to the
          widest row's intrinsic width and overflow — <main>'s overflow-x-clip
          then silently clips the +/- log controls off the right edge. min-w-0
          lets the column shrink to the viewport so each card's own
          truncate/flex handling takes over. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Act: the one-tap log bar. On mobile this grid cell leads (bar → Today → This
            week); on desktop it's the left column beside the sidebar. */}
        <div className="card min-w-0">
          <FoodLogBar
            today={date}
            yesterday={yesterday}
            initial={initial}
            initialYesterday={initialYesterday}
            groups={groups}
            slot={slot}
          />
          {/* A quiet link to where dietary preferences are set (#980 item 4), so the
              demote/substitute the suggestions summary notes is one tap from editable. */}
          <div className="mt-4 border-t border-black/5 pt-3 dark:border-white/5">
            <Link
              href="/settings/profile#nutrition"
              data-testid="food-preferences-link"
              className="text-xs text-slate-500 transition hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              Dietary preferences
            </Link>
          </div>
        </div>

        {/* Sidebar regrouped by time horizon (#980 item 3): Today above This week. */}
        <div className="min-w-0 space-y-6 self-start">
          {/* Today: today's feedback — the nutrients card, pairing with the log bar's
              #950 slot chip. */}
          {(proteinToday || proteinAdequacy || fiberAdequacy) && (
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
          )}

          {/* This week: weekly reflection — the rollup and the (trend-deepened, #954)
              habits card. */}
          <section data-testid="nutrition-week-section" className="space-y-3">
            <h2 className="section-label">This week</h2>
            <div className="card">
              <h3 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                Servings
              </h3>
              <FoodWeeklyRollup rollup={rollup} />
            </div>
            <WeeklyHabits profileId={profile.id} />
          </section>
        </div>
      </div>
    </div>
  );
}
