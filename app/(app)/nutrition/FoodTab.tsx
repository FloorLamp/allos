import { requireSession } from "@/lib/auth";
import { getDisplayFormatPrefs } from "@/lib/settings";
import { today } from "@/lib/db";
import { now as clockNow } from "@/lib/clock";
import { getTimezone } from "@/lib/settings";
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
import { usualRoutineDayOffers } from "@/lib/queries/usual-routine";
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
import LedgerDoorLink from "@/components/LedgerDoorLink";
import { historyHref } from "@/lib/hrefs";
import WeeklyHabits from "./WeeklyHabits";
import { trackFoodHabit } from "./actions";
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
import {
  buildDayLedger,
  type LedgerGroup,
  type LedgerServing,
} from "@/lib/day-ledger";
import { getDayDoseLedger } from "@/lib/queries/day-ledger";
import { getIntakeDosesForHistory } from "@/lib/queries/intake/schedule";
import { pendingDayDoses } from "@/lib/queries/usual-routine";
import { doseLogDays } from "@/lib/dose-log-window";
import {
  getFindingSuppressions,
  getIntakeItems,
  getIntakePairs,
} from "@/lib/queries";
import { activeByKey } from "@/lib/findings";
import { separatePairWarnings } from "@/lib/intake-pairs";
import { Notice } from "@/components/Notice";
import { DismissFindingButton } from "@/components/FindingCard";
import { TIME_BUCKETS } from "@/lib/intake-schedule";
import { workoutDaySubtitleLabel } from "@/lib/intake-schedule";
import {
  getActivitiesByDate,
  isPredictedWorkoutDay,
} from "@/lib/queries/training";
import { isTrainingRelevant } from "@/lib/life-stage";

// The Food tab of the Nutrition umbrella (#746): the food-group serving log (issue
// #579) — the INPUT half of nutrition.
// One-tap serving logging for today + a weekly rollup, plus the deterministic
// biomarker→food suggestions (#577) shown here as "food before pills." Habit tier,
// informational — never a calorie counter.

// HOW MANY DAYS THIS PAGE'S RECENT-MEAL PICKER OFFERS: today plus the previous six.
// A LENGTH, NOT A BOUND. It was `LEDGER_DAY_SPAN` in lib/day-ledger.ts and was also
// the selection edit's server-side move bound, deliberately one spelling. #4754's
// ruling retired that half: a move may reach any past day, the way the deep doors
// already do, so nothing on the server asks this question any more and the constant
// has no reason to sit in lib/ or to be shared. It is how much markup this picker
// draws, and #4477's ‹ › pager retires it outright when it replaces the picker.
const RECENT_DAY_PICKER_SPAN = 7;

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

// FIBER, STATED ONCE (#3987). The rail used to say it three times: the Today gauge, a
// WEEKLY FIBER TARGET block down in the weekly section, and the intake/target figures
// behind the methodology disclosure. The block and the figures are gone; what the block
// alone knew — the week's average logged day, which is a different fact from today's —
// is this ONE line, inside the fiber block it belongs to.
function WeeklyFiberLine({ adequacy }: { adequacy: FiberAdequacy }) {
  const { intake, target, status } = adequacy;
  return (
    <p
      data-testid="nutrition-weekly-fiber"
      className="mt-1 flex items-baseline justify-between gap-3 text-xs text-slate-500 dark:text-slate-400"
    >
      <span>Avg logged day this week</span>
      <span className="inline-flex items-baseline gap-1 text-right tabular-nums">
        <span
          data-testid="nutrition-weekly-fiber-value"
          className="font-semibold text-slate-700 dark:text-slate-200"
        >
          {Math.round(intake.grams)}g
          {fiberBasisIsFloor(intake.basis) ? "+" : ""}
        </span>
        <span>/ {Math.round(target.grams)}g+ goal</span>
        <span
          data-testid="nutrition-weekly-fiber-status"
          className={`font-medium ${FIBER_STATUS_CLASS[status]}`}
        >
          {FIBER_STATUS_LABEL[status]}
        </span>
      </span>
    </p>
  );
}

// THE METHODOLOGY, NOT A SECOND STATEMENT. These lines live behind the nutrients
// card's "How estimates work" fold, and they say what the figures are MADE OF — a
// non-tracked basis is a floor, an unknown-unit supplement is noted, a day holding both
// a health-app reading and an in-app log names both. #3987's "stated once" is about
// what the rail RENDERS; a folded explanation of how a number was reached is not a
// third rendering of the number, and dropping it would take the honesty caveats with
// it.
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
          <EmptyState message="This profile is under one year old. The food-group serving log covers the adult habit catalog (leafy greens, whole grains, and so on) — infant feeding isn't tracked here. Growth for this age lives in the Body and History views." />
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
  const recentDates = Array.from({ length: RECENT_DAY_PICKER_SPAN }, (_, i) =>
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
  // THE DAY LEDGER (#3987 phase 1) — one statement of the day, per bounded date, built
  // by lib/day-ledger.ts from two gathers this page already had reason to make.
  //
  // THE WRITE WINDOW BOUNDS THE TAPS, NOT THE STATEMENT. `doseLogDays` is the PAST half
  // of the window `markDoseTaken`/`markDoseSkipped` enforce, so `doseWritable` decides
  // whether a due row is tappable — the ledger can never offer a tap the core would
  // refuse and never withhold one it would accept.
  //
  // It does NOT decide whether the day SAYS what it owed. Bounding the gather by the
  // window was the earlier shape and it was wrong twice over: it made `DayLedger`'s
  // read-only "Not recorded" row unreachable, and it rendered "Nothing logged yet." for a
  // day that owed two doses — a day-chip four days back answered "which doses did I miss
  // on Thursday?" before this rebuild (`SupplementsTab`'s `historicalStatus`, across all
  // seven picker days) and would have stopped answering it on four of the seven. The
  // issue's ruling is "beyond it they render read-only state", which is a statement, not
  // a silence. So the pending half is gathered for EVERY picker day and the window only
  // chooses the rendering.
  //
  // THE COST, MEASURED RATHER THAN ARGUED: over a 25-item stack, three days gathers in
  // 1.32 ms and seven in 2.68 ms — about 0.34 ms per extra day, ~1.4 ms added per render.
  // It roughly doubles this gather, which is worth stating plainly, and it buys back a
  // capability the rebuild had dropped. It is affordable because it is bounded by the
  // PICKER SPAN and runs against in-process SQLite. IT SCALES LINEARLY IN THAT SPAN: if
  // the day picker ever widens beyond ~7 days, this becomes a per-day cost on every
  // Nutrition render and wants batching into one query rather than N resolver calls.
  const doseWritable = new Set(doseLogDays(date));
  const doseWritableDates = [...doseWritable];
  // SUPPLEMENTS ONLY, on both halves. `pendingDayDoses` is kind-neutral — it also
  // serves the quick-log sheet, which covers medications — so the ledger applies the
  // same `isMed` exclusion the schedule it replaces applied, and the same one its
  // resolved half (`getDayDoseLedger`) applies in SQL. Medications keep their own
  // page: the umbrella ruling this redesign inherits rather than re-decides.
  const supplementItemIds = new Set(
    getIntakeItems(profile.id)
      .filter((item) => item.kind !== "medication")
      .map((item) => item.id)
  );
  const pendingByDate = new Map(
    mealDays.map((day) => [
      day.date,
      pendingDayDoses(profile.id, day.date).filter((dose) =>
        supplementItemIds.has(dose.itemId)
      ),
    ])
  );
  const doseSchedules = getIntakeDosesForHistory(profile.id);
  const ledgerByDate: Record<string, LedgerGroup[]> = Object.fromEntries(
    mealDays.map((day) => [
      day.date,
      buildDayLedger({
        servings: day.events.map((event): LedgerServing => ({
          kind: "serving",
          id: `serving:${event.id}`,
          eventId: event.id,
          slug: event.groupKey,
          name: event.name,
          bucket: event.mealSlot,
          // The EATING time where one was captured, else the filing time — with the
          // answer saying which, so the ledger renders "logged 8:06pm" for a row
          // nobody timed rather than a bare clock claiming an eating minute (#3958).
          hhmm: event.eatenAt ?? event.loggedTime,
          clockKind: event.eatenAt ? "stated" : "logged",
        })),
        doses: getDayDoseLedger(profile.id, day.date, doseSchedules),
        pending: pendingByDate.get(day.date) ?? [],
      }),
    ])
  );
  // KEEP-APART GUIDANCE RENDERS WHERE THE DUE DOSES ARE (#3987's anti-drop gate): it is
  // advice about what not to take together, so it belongs beside the taps rather than on
  // a management list. Current safety, never a historical claim, so it is computed for
  // TODAY only — exactly the scope the retired schedule gave it. Filtered through the
  // findings bus (#435) so a dismissal here or on Upcoming silences both.
  const intakePairs = getIntakePairs(profile.id);
  const ledgerSuppressions = getFindingSuppressions(profile.id);
  const todaysPending = pendingByDate.get(date) ?? [];
  const keepApart = TIME_BUCKETS.map((bucket) => ({
    bucket: bucket as string,
    // RENDERED HERE, on the server, because the dismissal is a server action: the
    // ledger is a client island and may render these nodes but cannot import them.
    warnings: activeByKey(
      separatePairWarnings(
        todaysPending.filter((d) => d.bucket === bucket).map((d) => d.itemId),
        intakePairs
      ),
      (w) => w.key,
      ledgerSuppressions,
      date
    ),
  }))
    .filter((entry) => entry.warnings.length > 0)
    .map((entry) => ({
      bucket: entry.bucket,
      content: (
        <>
          {entry.warnings.map((warning) => (
            <Notice
              key={warning.key}
              tone="amber"
              icon
              className="mb-2"
              action={
                <DismissFindingButton
                  dedupeKey={warning.key}
                  label={`Dismiss: ${warning.text}`}
                />
              }
            >
              {warning.text}
            </Notice>
          ))}
        </>
      ),
    }));
  // The workout/rest context line the retired schedule carried (#3987's anti-drop
  // gate). Day-shaped, so it moves to the day surface; absent where training is not
  // tracked, which is the same gate the schedule applied.
  const ledgerDayContext = isTrainingRelevant(getProfileAge(profile.id))
    ? workoutDaySubtitleLabel(
        isPredictedWorkoutDay(profile.id, date),
        getActivitiesByDate(profile.id, date).length > 0
      )
    : null;
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
  // Direct protein-grams quick-add (#824): each offered day's manual total + the last-used amount
  // (the repeated scoop size) to pre-fill the box. Protein powder's only home.
  const proteinLoggedGramsByDate = Object.fromEntries(
    mealDays.map((day) => [
      day.date,
      getProteinDailyGrams(profile.id, day.date),
    ])
  );
  const proteinPreset = getProteinQuickAddPreset(profile.id);
  // Current food slot (#950): the profile's wall-clock window (Morning/Midday/Evening)
  // in its timezone. Drives the slot-aware ranking AND the bar's slot chip — the SAME
  // derivation, so the label and the order can never disagree.
  const slot = currentFoodSlot(profile.id);
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
                thing — an act, in the "Act" column. It is NOT here because the state
                has to be on screen for the end-fast offer to land: that offer is a
                post-write TOAST fired after the serving has already landed (#2756's
                offer-after-the-fact shape), so it reaches the user whether or not this
                surface is expanded — which is what lets the idle state fold to one
                affordance (#3672).
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
              usualBySlot={usualBySlot}
              // THE DOSE HALF, SEEDED FOR THE DAY THIS PAGE RENDERED (#4438). The bar
              // re-reads through `usualRoutineOffersOn` when its day picker moves.
              usualRoutine={{
                date,
                offers: usualRoutineDayOffers(profile.id, date),
              }}
              slot={slot}
              // The same boundaries the tallies derive windows from, so the correction
              // sheet's follow-the-hour Meal default (#2227 d4) can never disagree with
              // the window the server will count the corrected serving in.
              slotBoundaries={profileFoodSlotBoundaries(profile.id)}
              nutrientSummaryByDate={mobileNutrients}
              ledgerDoor={
                <LedgerDoorLink
                  href={historyHref({ kind: "food" })}
                  label="Food history"
                  testId="food-ledger-link"
                />
              }
              dayLedger={{
                groupsByDate: ledgerByDate,
                doseWritableDates,
                prefs: formatPrefs,
                keepApart,
                dayContext: ledgerDayContext,
              }}
              proteinQuickAdd={{
                initialGramsByDate: proteinLoggedGramsByDate,
                lastPreset: proteinPreset,
              }}
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
                  <div>
                    <FiberAdequacyCard
                      adequacy={fiberToday}
                      periodLabel="Today"
                    />
                    {fiberAdequacy && (
                      <WeeklyFiberLine adequacy={fiberAdequacy} />
                    )}
                  </div>
                )}
              </NutrientsCard>
            </section>
          )
        }
        weeklySidebar={
          // ONE THIS-WEEK LIST (#3987). The rollup and the habits section were two
          // lists of the same groups for the same week; `WeeklyHabits` now owns the
          // merged one, so this section holds it and the co-read panel and nothing
          // else. Weekly reflection remains visible for every selected date because it
          // is explicitly labeled as a weekly context rather than a daily one.
          <section
            key="nutrition-week"
            data-testid="nutrition-week-section"
            className="space-y-5"
          >
            <WeeklyHabits
              profileId={profile.id}
              formatPrefs={formatPrefs}
              rollup={rollup}
              embedded
            />
            {/* Fiber × GI symptoms read together (#2788): rendered only when BOTH
                series have something in the window — with either empty there is
                nothing to co-read, and silence beats an empty exhortation. */}
            {fiberSymptomPanelHasSignal(fiberSymptomPanel) && (
              <div className="border-t border-black/5 pt-5 dark:border-white/5">
                <FiberSymptomPanel
                  panel={fiberSymptomPanel}
                  formatPrefs={formatPrefs}
                />
              </div>
            )}
          </section>
        }
      />
    </div>
  );
}
