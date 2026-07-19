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
  PACE_BADGE_CLASS,
} from "@/lib/goals";
import { FOOD_GROUPS } from "@/lib/food-groups";
import {
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "@/lib/food-habit";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import SubmitButton from "@/components/SubmitButton";
import { trackFoodHabit } from "./actions";
import UntrackHabitButton from "./UntrackHabitButton";

// Per-verdict cell styling for the N-week consistency strip (#954). `met` reads green,
// `short`/`empty` amber/slate, the in-progress current week a hollow brand ring, and a
// not-applicable (pre-target) week a faint dashed placeholder — an honest cold start,
// never a red miss.
const TREND_CELL_CLASS: Record<HabitWeekVerdict, string> = {
  met: "bg-emerald-500 dark:bg-emerald-500",
  short: "bg-amber-400 dark:bg-amber-500",
  empty: "bg-slate-200 dark:bg-slate-700",
  current:
    "bg-transparent ring-1 ring-inset ring-brand-400 dark:ring-brand-500",
  na: "bg-transparent ring-1 ring-inset ring-dashed ring-slate-200 dark:ring-slate-700 opacity-50",
};

// Food-habit targets card (issue #580): the profile's food_group frequency targets with
// this-week progress (the #579 rollup via getFrequencyTargetProgress — one computation),
// plus an add form. User-initiated, reversible; a target here is the SAME row a protocol
// can adopt as its intervention (frequency_target_id).

export default function WeeklyHabits({
  profileId,
  formatPrefs,
}: {
  profileId: number;
  formatPrefs?: DisplayFormatPrefs;
}) {
  const habits = getFrequencyTargetProgress(profileId).filter(
    (p) => p.target.scope_kind === "food_group"
  );
  // Active medications from the ONE shared intake-safety gather (#661) — a food-group
  // habit that conflicts with the stack carries the SAME interaction note the
  // medication's own row shows (informational, never blocking the habit).
  const medications = getIntakeSafetyContext(profileId).medications;
  // The protocol (if any) that adopted each habit as its intervention — so untracking a
  // measured habit confirms first (#748 item 6).
  const protocolByTarget = getFrequencyTargetProtocolNames(profileId);
  // N-week consistency trend per habit (#954): the same weekly rollup extended over
  // ~8 weeks so "is this habit sticking?" gets a surface. Keyed by target id.
  const trends = getFoodHabitTrends(profileId, formatPrefs);

  return (
    <div className="card" data-testid="weekly-habits">
      <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
        Weekly habits
      </h2>

      {habits.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
          Track a food group as a weekly habit — e.g. fatty fish 2×/week.
        </p>
      ) : (
        <ul className="mb-3 space-y-1.5">
          {habits.map((p) => {
            const interactions = foodHabitInteractions(
              p.target.scope_value,
              medications
            );
            return (
              <li
                key={p.target.id}
                data-testid={`habit-${p.target.scope_value}`}
                className="text-sm"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-slate-700 dark:text-slate-200">
                    <FoodGroupIcon
                      slug={p.target.scope_value}
                      className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400"
                    />
                    {frequencyScopeLabel("food_group", p.target.scope_value)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                      {p.count} / {p.per_week}
                    </span>
                    <span
                      data-testid={`habit-pace-${p.target.scope_value}`}
                      data-pace={p.pace}
                      className={`badge ${PACE_BADGE_CLASS[p.pace]}`}
                    >
                      {frequencyPaceLabel(p.pace)}
                    </span>
                    <UntrackHabitButton
                      targetId={p.target.id}
                      protocolName={protocolByTarget.get(p.target.id) ?? null}
                    />
                  </span>
                </div>
                {(() => {
                  const cells = trends.get(p.target.id) ?? [];
                  if (cells.length === 0) return null;
                  return (
                    <div
                      data-testid={`habit-trend-${p.target.scope_value}`}
                      className="mt-1.5 flex items-center gap-1"
                      role="img"
                      aria-label={`Consistency over the last ${cells.length} weeks`}
                    >
                      {cells.map((c) => (
                        <span
                          key={c.start}
                          data-verdict={c.verdict}
                          title={c.label}
                          className={`h-3 w-3 shrink-0 rounded-sm ${TREND_CELL_CLASS[c.verdict]}`}
                        />
                      ))}
                    </div>
                  );
                })()}
                {interactions.length > 0 && (
                  <ul
                    data-testid={`habit-warning-${p.target.scope_value}`}
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

      <form
        action={async (fd) => {
          "use server";
          await trackFoodHabit(fd);
        }}
        className="flex flex-wrap items-center gap-2"
        data-testid="add-habit-form"
      >
        <select
          name="group_key"
          aria-label="Food group"
          className="input flex-1 text-sm"
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
        <SubmitButton className="btn text-sm" pendingLabel="Tracking…">
          Track
        </SubmitButton>
      </form>
    </div>
  );
}
