"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import type { Goal } from "@/lib/types";
import type { GoalProgress } from "@/lib/queries";
import type { WeightUnit } from "@/lib/settings";
import {
  goalBarClass,
  goalPct,
  goalTargetText,
  goalBodyTargetText,
  fmtBodyMetric,
} from "@/lib/goals";
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
import { EmptyState, Tag } from "@/components/ui";
import {
  updateProgress,
  setStatus,
  setArchived,
  deleteGoal,
} from "@/app/(app)/goals/actions";
import GoalForm from "@/app/(app)/goals/GoalForm";

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
  weightUnit,
}: {
  goals: Goal[];
  goalProgress: Record<number, GoalProgress>;
  lifts: string[];
  weightUnit: WeightUnit;
}) {
  const wu = weightUnit;
  // Day math (countdown/overdue) follows the app's configured timezone, not the
  // browser's, so "today" matches the rest of the app.
  const todayStr = dateStrInTz(useTimezone());
  // null = closed; { goal } = open (goal undefined → create, set → edit).
  const [modal, setModal] = useState<{ goal?: Goal } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // Which goal's action menu is open (id), or null.
  const [openMenu, setOpenMenu] = useState<number | null>(null);
  const confirm = useConfirm();

  // The goal actions now return a typed FormResult, but the menu's runAction
  // helper and the inline <form action> want a void-returning action, and these
  // toggle/progress surfaces have no inline error slot — adapt each to Promise<void>
  // (a failed guard just no-ops the optimistic toast, same as before the contract).
  const setStatusV = async (fd: FormData) => {
    await setStatus(fd);
  };
  const setArchivedV = async (fd: FormData) => {
    await setArchived(fd);
  };
  const deleteGoalV = async (fd: FormData) => {
    await deleteGoal(fd);
  };
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
            const auto = isExercise || isBody; // progress derived automatically
            const prog = auto ? goalProgress[g.id] : undefined;
            const pct = goalPct(g, prog);

            return (
              <div
                key={g.id}
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
                    ) : (
                      g.category && (
                        <span className="text-xs text-slate-400 dark:text-slate-500">
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
                              runAction(setStatusV, fd, "Marked active")
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
                              runAction(setStatusV, fd, "Goal achieved 🎉")
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
                              setArchivedV,
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
                            await runAction(deleteGoalV, fd, "Goal deleted");
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
                            : `${g.current_value} / ${g.target_value} ${g.unit ?? ""}`}
                      </span>
                      <span>{pct}%</span>
                    </div>
                    {/* Lifetime PR, shown only when it beats the recent-window
                        best — so a detrained goal still surfaces the record. */}
                    {isExercise &&
                      prog &&
                      (prog.lifetimeBest ?? 0) > prog.current && (
                        <div className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">
                          PR {goalValueText(g, prog.lifetimeBest!, wu)}
                        </div>
                      )}
                    <div className="mt-1 h-2 w-full rounded-full bg-slate-100 dark:bg-ink-800">
                      <div
                        className={`h-2 rounded-full transition-colors ${goalBarClass(pct)}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                )}

                {g.target_date && (
                  <div className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                    Target: {formatLongDate(g.target_date)}
                    {(() => {
                      const label = daysRemainingLabel(g.target_date, todayStr);
                      const n = daysUntil(g.target_date, todayStr);
                      // Only flag as overdue for goals still being pursued.
                      const overdue =
                        n != null &&
                        n < 0 &&
                        g.status === "active" &&
                        !g.archived;
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
            weightUnit={weightUnit}
            editGoal={modal.goal}
            onDone={() => setModal(null)}
          />
        </ModalShell>
      )}
    </div>
  );
}
