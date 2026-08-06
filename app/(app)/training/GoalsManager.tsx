"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import type { Goal } from "@/lib/types";
import type { GoalProgress } from "@/lib/queries";
import type { WeightUnit } from "@/lib/settings";
import {
  goalBarClass,
  goalPaceTone,
  goalPct,
  goalTargetText,
  goalBodyTargetText,
  fmtBodyMetric,
  isGoalLive,
} from "@/lib/goals";
import {
  biomarkerGoalCheckInText,
  biomarkerGoalCurrentText,
  biomarkerGoalTargetText,
  isBiomarkerGoal,
} from "@/lib/biomarker-goal";
import { fmtWeight } from "@/lib/units";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import ModalShell from "@/components/ModalShell";
import SubmitButton from "@/components/SubmitButton";
import { useTimezone } from "@/components/TimezoneProvider";
import { dateStrInTz } from "@/lib/date";
import { formatSeconds } from "@/lib/duration";
import {
  formatLongDate,
  daysRemainingLabel,
  daysUntil,
} from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { EmptyState, Tag } from "@/components/ui";
import {
  updateProgress,
  setStatus,
  setArchived,
  deleteGoal,
} from "@/app/(app)/training/goal-actions";
import GoalForm from "@/app/(app)/training/GoalForm";
import type { GoalBiomarkerOption } from "@/app/(app)/training/goal-target-options";

// A progress value, formatted for the goal's metric.
function goalValueText(g: Goal, value: number, wu: WeightUnit): string {
  if (g.metric === "weight") return fmtWeight(value, wu);
  if (g.metric === "hold") return formatSeconds(value);
  return String(value);
}

// Goal list + create/edit modal. The "New goal" button and per-card "Edit"
// open one shared modal hosting GoalForm (create when no goal, edit otherwise).
export default function GoalsManager({
  goals,
  goalProgress,
  lifts,
  equipment,
  equipmentByExercise,
  weightUnit,
  biomarkerOptions,
}: {
  goals: Goal[];
  goalProgress: Record<number, GoalProgress>;
  lifts: string[];
  // The profile's equipment registry (id + display name, retired included so a goal
  // scoped to sold gear still names it) and, per canonical movement key, the
  // implements that movement has actually been logged on (#1610). Both are inert for
  // a profile that owns no equipment — the goal form then renders no picker at all.
  equipment: { id: number; name: string }[];
  equipmentByExercise: Record<string, number[]>;
  weightUnit: WeightUnit;
  biomarkerOptions: GoalBiomarkerOption[];
}) {
  const wu = weightUnit;
  const formatPrefs = useFormatPrefs();
  // Day math (countdown/overdue) follows the app's configured timezone, not the
  // browser's, so "today" matches the rest of the app.
  const todayStr = dateStrInTz(useTimezone());
  // null = closed; { goal } = open (goal undefined → create, set → edit).
  const [modal, setModal] = useState<{ goal?: Goal } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Which goal's action menu is open (id), or null.
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const confirm = useConfirm();

  // The status/archive/delete transitions hand their typed FormResult straight to
  // the menu's runAction (#2140): a refusal (forged or since-deleted id) toasts its
  // error instead of being swallowed under the optimistic success message —
  // FormResult is a MenuActionResult, so no adapter. Only the inline progress form
  // still wants a void action (it has no result slot), so it alone keeps one.
  const updateProgressV = async (fd: FormData) => {
    await updateProgress(fd);
  };

  const archivedCount = goals.filter((g) => g.archived).length;
  const visibleGoals = showArchived ? goals : goals.filter((g) => !g.archived);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Goals
          </h2>
          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {showArchived
                ? "Hide archived"
                : `Show archived (${archivedCount})`}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setModal({})}
          className="btn inline-flex items-center gap-1.5"
        >
          <IconPlus className="h-4 w-4" /> New goal
        </button>
      </div>

      {goals.length === 0 ? (
        <EmptyState message="No goals yet. Create one with “New goal”." />
      ) : visibleGoals.length === 0 ? (
        <EmptyState message="All goals are archived. Use “Show archived” to see them." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleGoals.map((g) => {
            const isExercise = g.metric != null && g.exercise != null;
            const isBody = g.body_metric != null;
            const isBio = isBiomarkerGoal(g);
            const auto = isExercise || isBody || isBio; // progress derived automatically
            const prog = auto ? goalProgress[g.id] : undefined;
            const pct = goalPct(g, prog);
            // A lab goal's pace advances on RESULTS, not on the calendar — the owed
            // line is frozen at the last reading, so a goal cannot slide to "behind"
            // on a day when no lab was drawn (#1853). Every other goal keeps the
            // daily model by omitting the field entirely.
            const paceOpts = {
              createdAt: g.created_at,
              targetDate: g.target_date,
              today: todayStr,
              ...(isBio ? { evidenceDate: prog?.asOf ?? null } : {}),
            };

            return (
              <div
                key={g.id}
                data-testid="goal-card"
                className={`card !p-3 text-sm ${
                  g.archived ? "opacity-55 grayscale" : ""
                } ${openMenu === g.id ? "relative z-20" : ""}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                        {g.title}
                      </h3>
                      <Tag value={g.status} />
                      {g.archived ? (
                        <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                          Archived
                        </span>
                      ) : null}
                    </div>
                    {isExercise ? (
                      <span className="text-xs text-brand-600 dark:text-brand-400">
                        {goalTargetText(g, wu)}
                      </span>
                    ) : isBody ? (
                      <span className="text-xs text-brand-600 dark:text-brand-400">
                        {goalBodyTargetText(g, wu)}
                      </span>
                    ) : isBio ? (
                      <span
                        className="text-xs text-brand-600 dark:text-brand-400"
                        data-testid="goal-biomarker-target"
                      >
                        {biomarkerGoalTargetText(g)}
                      </span>
                    ) : (
                      g.category && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {g.category}
                        </span>
                      )
                    )}
                  </div>
                  <OverflowMenu
                    label="Goal actions"
                    open={openMenu === g.id}
                    onOpenChange={(o) => setOpenMenu(o ? g.id : null)}
                  >
                    {({ close, runAction }) => (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setModal({ goal: g });
                            close();
                          }}
                          className={MENU_ITEM}
                        >
                          Edit
                        </button>
                        {/* Achievement toggle — independent of archiving. */}
                        {g.status === "achieved" ? (
                          <form
                            action={(fd) =>
                              runAction(setStatus, fd, "Marked active")
                            }
                          >
                            <input type="hidden" name="id" value={g.id} />
                            <input type="hidden" name="status" value="active" />
                            <button
                              type="submit"
                              role="menuitem"
                              className={MENU_ITEM}
                            >
                              Mark active
                            </button>
                          </form>
                        ) : (
                          <form
                            action={(fd) =>
                              runAction(setStatus, fd, "Goal achieved 🎉")
                            }
                          >
                            <input type="hidden" name="id" value={g.id} />
                            <input
                              type="hidden"
                              name="status"
                              value="achieved"
                            />
                            <button
                              type="submit"
                              role="menuitem"
                              className={`${MENU_ITEM} ${
                                prog?.done
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : ""
                              }`}
                            >
                              Mark achieved
                            </button>
                          </form>
                        )}
                        {/* Archive toggle — preserves the achieved state. */}
                        <form
                          action={(fd) =>
                            runAction(
                              setArchived,
                              fd,
                              g.archived ? "Goal unarchived" : "Goal archived"
                            )
                          }
                        >
                          <input type="hidden" name="id" value={g.id} />
                          <input
                            type="hidden"
                            name="archived"
                            value={g.archived ? "0" : "1"}
                          />
                          <button
                            type="submit"
                            role="menuitem"
                            className={MENU_ITEM}
                          >
                            {g.archived ? "Unarchive" : "Archive"}
                          </button>
                        </form>
                        {/* Plain button (not a form action): confirm() opens a
                            modal the user must answer, which deadlocks inside a
                            form-action transition. onClick shows it. */}
                        <button
                          type="button"
                          role="menuitem"
                          className={MENU_ITEM_DANGER}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "Delete goal",
                              message: `Delete the goal “${g.title}”? This can’t be undone.`,
                              confirmLabel: "Delete",
                              danger: true,
                            });
                            if (!ok) return;
                            const fd = new FormData();
                            fd.set("id", String(g.id));
                            await runAction(deleteGoal, fd, "Goal deleted");
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </OverflowMenu>
                </div>

                {g.description && (
                  <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                    {g.description}
                  </p>
                )}

                {pct != null && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-slate-500 dark:text-slate-400">
                      <span>
                        {isExercise && prog
                          ? `${goalValueText(g, prog.current, wu)} in last 4 wks`
                          : isBody && prog
                            ? `${prog.current > 0 ? fmtBodyMetric(g.body_metric!, prog.current, wu) : "—"} now`
                            : isBio
                              ? biomarkerGoalCurrentText(prog)
                              : `${g.current_value} / ${g.target_value} ${g.unit ?? ""}`}
                      </span>
                      <span>{pct}%</span>
                    </div>
                    {/* Lifetime PR, shown only when it beats the recent-window
                        best — so a detrained goal still surfaces the record. */}
                    {isExercise &&
                      prog &&
                      (prog.lifetimeBest ?? 0) > prog.current && (
                        <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          PR {goalValueText(g, prog.lifetimeBest!, wu)}
                        </div>
                      )}
                    <div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                      <div
                        data-testid="goal-bar"
                        data-tone={goalPaceTone(pct, paceOpts)}
                        className={`h-2 rounded-full transition-colors ${goalBarClass(
                          pct,
                          paceOpts
                        )}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    {/* The check-in rhythm (#1853): a lab goal's natural cadence is
                        the analyte's own retest interval, so between draws the honest
                        thing to say is when the next result is expected — not a
                        freshly recomputed verdict about a day nothing was measured. */}
                    {isBio && prog?.checkIn && (
                      <div
                        className="mt-0.5 text-xs text-slate-500 dark:text-slate-400"
                        data-testid="goal-check-in"
                      >
                        {biomarkerGoalCheckInText(prog.checkIn, (d) =>
                          formatLongDate(d, formatPrefs)
                        )}
                      </div>
                    )}
                  </div>
                )}

                {g.target_date && (
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                    Target: {formatLongDate(g.target_date, formatPrefs)}
                    {(() => {
                      const label = daysRemainingLabel(g.target_date, todayStr);
                      const n = daysUntil(g.target_date, todayStr);
                      // Only flag as overdue for goals still being pursued.
                      const overdue = n != null && n < 0 && isGoalLive(g);
                      return label ? (
                        <span
                          className={
                            overdue ? "text-rose-500 dark:text-rose-400" : ""
                          }
                        >
                          {" "}
                          · {label}
                        </span>
                      ) : null;
                    })()}
                  </div>
                )}

                {!auto && (
                  <form
                    action={updateProgressV}
                    className="mt-3 flex items-center gap-2"
                  >
                    <input type="hidden" name="id" value={g.id} />
                    <input
                      type="number"
                      step="any"
                      name="current_value"
                      defaultValue={g.current_value ?? 0}
                      className="input w-24 py-1"
                      aria-label="Current value"
                    />
                    <SubmitButton className="btn-ghost py-1">
                      Update
                    </SubmitButton>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <ModalShell
          title={modal.goal ? "Edit goal" : "New goal"}
          onClose={() => setModal(null)}
        >
          <GoalForm
            lifts={lifts}
            equipment={equipment}
            equipmentByExercise={equipmentByExercise}
            weightUnit={weightUnit}
            biomarkerOptions={biomarkerOptions}
            editGoal={modal.goal}
            onDone={() => setModal(null)}
          />
        </ModalShell>
      )}
    </div>
  );
}
