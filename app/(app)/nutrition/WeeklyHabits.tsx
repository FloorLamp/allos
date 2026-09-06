import { IconAlertTriangle } from "@tabler/icons-react";
import {
  getFrequencyTargetProgress,
  getFrequencyTargetProtocolNames,
  getFoodHabitTrends,
  getIntakeSafetyContext,
} from "@/lib/queries";
import type { HabitWeekVerdict } from "@/lib/food-habit-trend";
import type { DisplayFormatPrefs } from "@/lib/format-date";
import {
  frequencyScopeLabel,
  frequencyPaceLabel,
} from "@/lib/frequency-targets";
import { PACE_BADGE_CLASS } from "@/lib/pace-presentation";
import { FOOD_GROUPS } from "@/lib/food-groups";
import {
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "@/lib/food-habit";
import FoodGroupIcon, {
  FOOD_GROUP_TIER_TINT,
} from "@/components/FoodGroupIcon";
import RightSizeSuggestions from "@/components/RightSizeSuggestions";
import SubmitButton from "@/components/SubmitButton";
import Disclosure from "@/components/Disclosure";
import { EmptyState } from "@/components/ui";
import { StateCells } from "@/components/StateCells";
import { chartAdherenceState } from "@/lib/chart-colors";
import { foodGroupBySlug } from "@/lib/food-groups";
import type { GroupServingTotal } from "@/lib/food-daily-totals";
import { trackFoodHabit } from "./actions";
import UntrackHabitButton from "./UntrackHabitButton";

// The N-week consistency strip (#954) speaks the app's ONE adherence vocabulary
// (#4543): a week that met its target is `taken`, a short week is `partial` — some
// of the same thing, which is exactly what the shared pair means — an empty week the
// neutral `skipped` rather than a red miss, the in-progress week `pending`, and a
// pre-target week `na`. It used to hand-pick its own Tailwind classes, which is a
// palette decision made outside `lib/chart-colors`.
const TREND_TONE: Record<HabitWeekVerdict, string> = {
  met: chartAdherenceState.taken.class,
  short: chartAdherenceState.partial.class,
  empty: chartAdherenceState.skipped.class,
  current: chartAdherenceState.pending.class,
  na: chartAdherenceState.na.class,
};

// THIS WEEK, AS ONE LIST (issue #580, consolidated by #3987).
//
// The rail used to answer "what did I eat this week?" twice: a WEEKLY ROLLUP listing
// every logged group with its servings, and a WEEKLY HABITS section listing the tracked
// subset of those same groups with a target and a pace badge. Same groups, same week,
// two lists, adjacent. This is the ONE list — a row per group, with the target, the pace
// and the consistency pips carried INLINE on the rows that have them.
//
// THE UNION IS THE POINT, and it is why this owns the merge rather than the rollup
// component: a tracked habit with nothing logged this week has no rollup row and is
// exactly the row a person needs to see. It appears at zero, "Behind" and all.
//
// The per-habit weekly-details buttons are gone with the second list (owner ruling: no
// per-habit detail buttons); the pips keep their `aria-label`, which is what carried the
// non-visual reading of them. The add form is ONE affordance, folded, in the
// rare-cadence idiom (#1497) — tracking a habit is a rare act and a standing form is a
// tax on every visit.
//
// A target here is the SAME row a protocol can adopt as its intervention
// (frequency_target_id); tracking stays user-initiated and reversible.

export default function WeeklyHabits({
  profileId,
  formatPrefs,
  rollup,
  embedded = false,
}: {
  profileId: number;
  formatPrefs?: DisplayFormatPrefs;
  /** This week's logged servings per group — the other half of the one list. */
  rollup: GroupServingTotal[];
  embedded?: boolean;
}) {
  const habits = getFrequencyTargetProgress(profileId).filter(
    (p) => p.target.scope_kind === "food_group"
  );
  // Active medications from the ONE shared intake-safety gather (#661) — a food-group
  // habit that conflicts with the stack carries the SAME interaction note the
  // medication's own row shows (informational, never blocking the habit).
  const medications = getIntakeSafetyContext(profileId).medications;
  // The protocol (if any) that adopted each habit as its intervention — so untracking a
  // measured habit confirms first (#748 item 6). Read at every age (#3133): an
  // existing protocol is the profile's own record, never filtered from that
  // profile (#3067) — only protocol creation is adult-gated.
  const protocolByTarget = getFrequencyTargetProtocolNames(profileId);
  // N-week consistency trend per habit (#954): the same weekly rollup extended over
  // ~8 weeks so "is this habit sticking?" gets a surface. Keyed by target id.
  const trends = getFoodHabitTrends(profileId, formatPrefs);

  // THE ONE LIST: every group with servings this week, plus every tracked group that
  // has none. Ordered servings-descending then by name, so the hierarchy is legible and
  // two weeks with the same contents read the same; a zero-serving habit lands at the
  // end, which is where "you have not done this yet" belongs.
  const byHabit = new Map(habits.map((p) => [p.target.scope_value, p]));
  const rows = [
    ...rollup.map((g) => ({
      slug: g.slug,
      name: g.name,
      tier: g.tier,
      servings: g.servings,
    })),
    ...habits
      .filter((p) => !rollup.some((g) => g.slug === p.target.scope_value))
      .map((p) => {
        const group = foodGroupBySlug(p.target.scope_value);
        return {
          slug: p.target.scope_value,
          name:
            group?.name ??
            frequencyScopeLabel("food_group", p.target.scope_value),
          tier: group?.tier ?? "neutral",
          servings: 0,
        };
      }),
  ].sort(
    (a, b) =>
      b.servings - a.servings ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );

  return (
    <div className={embedded ? undefined : "card"} data-testid="weekly-habits">
      <h3 className="mb-3 section-label">This week</h3>

      {/* Right-sizing suggestions (#1670), above the habits they are about: a
          servings target the profile has been under for four completed weeks,
          offered for the intake they actually keep or for no target at all. */}
      <div className="mb-3">
        <RightSizeSuggestions profileId={profileId} domain="food" />
      </div>

      {rows.length === 0 ? (
        <EmptyState message="No servings logged this week yet." />
      ) : (
        <ul data-testid="food-weekly-rollup" className="mb-3 space-y-1.5">
          {rows.map((row) => {
            const habit = byHabit.get(row.slug);
            const interactions = habit
              ? foodHabitInteractions(row.slug, medications)
              : [];
            const cells = habit ? (trends.get(habit.target.id) ?? []) : [];
            return (
              <li
                key={row.slug}
                data-testid={`rollup-${row.slug}`}
                className="text-sm"
              >
                <div className="flex items-center gap-2">
                  <FoodGroupIcon
                    slug={row.slug}
                    className={`h-4 w-4 shrink-0 ${FOOD_GROUP_TIER_TINT[row.tier]}`}
                  />
                  <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                    {row.servings % 1 === 0
                      ? row.servings
                      : row.servings.toFixed(1)}
                  </span>
                  <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">
                    {row.name}
                  </span>
                  {habit && (
                    <span
                      data-testid={`habit-${row.slug}`}
                      className="flex shrink-0 items-center gap-2"
                    >
                      <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                        of {habit.per_week}
                      </span>
                      <span
                        data-testid={`habit-pace-${row.slug}`}
                        data-pace={habit.pace}
                        className={`badge ${PACE_BADGE_CLASS[habit.pace]}`}
                      >
                        {frequencyPaceLabel(habit.pace)}
                      </span>
                      <UntrackHabitButton
                        targetId={habit.target.id}
                        protocolName={
                          protocolByTarget.get(habit.target.id) ?? null
                        }
                      />
                    </span>
                  )}
                </div>
                {cells.length > 0 && (
                  <StateCells
                    testId={`habit-trend-${row.slug}`}
                    className="mt-1.5 pl-6"
                    label={`Consistency over the last ${cells.length} weeks: ${cells
                      .map((c) => c.label)
                      .join("; ")}`}
                    cells={cells.map((c) => ({
                      key: c.start,
                      tone: TREND_TONE[c.verdict],
                      state: c.verdict,
                    }))}
                  />
                )}
                {interactions.length > 0 && (
                  <ul
                    data-testid={`habit-warning-${row.slug}`}
                    className="mt-1 space-y-0.5"
                  >
                    {interactions.map((i) => (
                      <li
                        key={i.key}
                        className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400"
                      >
                        <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span>{foodHabitInteractionNote(i)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Disclosure data-testid="track-habit-fold">
        <summary
          data-testid="track-habit-summary"
          className="fold-control flex list-none items-center text-xs font-medium text-slate-500 [&::-webkit-details-marker]:hidden dark:text-slate-400"
        >
          Track a habit
        </summary>
        <form
          action={async (fd) => {
            "use server";
            await trackFoodHabit(fd);
          }}
          className="mt-2 flex flex-wrap items-center gap-2"
          data-testid="add-habit-form"
        >
          <select
            name="group_key"
            aria-label="Food group"
            className="input flex-[2_1_12rem] text-sm"
            defaultValue="fatty_fish"
          >
            {FOOD_GROUPS.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
          <input
            type="number"
            name="per_week"
            min={1}
            max={21}
            defaultValue={2}
            aria-label="Servings per week"
            className="input w-16 text-sm"
          />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            /week
          </span>
          <SubmitButton pendingLabel="Tracking…" variant="primary">
            Track
          </SubmitButton>
        </form>
      </Disclosure>
    </div>
  );
}
