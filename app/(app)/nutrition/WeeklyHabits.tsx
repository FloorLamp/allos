import { IconX, IconAlertTriangle } from "@tabler/icons-react";
import {
  getFrequencyTargetProgress,
  getIntakeSafetyContext,
} from "@/lib/queries";
import { frequencyScopeLabel } from "@/lib/goals";
import { FOOD_GROUPS } from "@/lib/food-groups";
import {
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "@/lib/food-habit";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import SubmitButton from "@/components/SubmitButton";
import { trackFoodHabit, untrackFoodHabit } from "./actions";

// Food-habit targets card (issue #580): the profile's food_group frequency targets with
// this-week progress (the #579 rollup via getFrequencyTargetProgress — one computation),
// plus an add form. User-initiated, reversible; a target here is the SAME row a protocol
// can adopt as its intervention (frequency_target_id).

export default function WeeklyHabits({ profileId }: { profileId: number }) {
  const habits = getFrequencyTargetProgress(profileId).filter(
    (p) => p.target.scope_kind === "food_group"
  );
  // Active medications from the ONE shared intake-safety gather (#661) — a food-group
  // habit that conflicts with the stack carries the SAME interaction note the
  // medication's own row shows (informational, never blocking the habit).
  const medications = getIntakeSafetyContext(profileId).medications;

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
                      className="h-4 w-4 shrink-0 text-slate-400 dark:text-slate-500"
                    />
                    {frequencyScopeLabel("food_group", p.target.scope_value)}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                      {p.count} / {p.per_week}
                    </span>
                    <span
                      className={`badge ${
                        p.met
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                      }`}
                    >
                      {p.met ? "On track" : "Behind"}
                    </span>
                    <form
                      action={async (fd) => {
                        "use server";
                        await untrackFoodHabit(fd);
                      }}
                    >
                      <input
                        type="hidden"
                        name="target_id"
                        value={p.target.id}
                      />
                      <button
                        type="submit"
                        aria-label="Stop tracking this habit"
                        className="flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-black/5 hover:text-slate-600 dark:hover:bg-white/10"
                      >
                        <IconX className="h-4 w-4" stroke={2} />
                      </button>
                    </form>
                  </span>
                </div>
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
