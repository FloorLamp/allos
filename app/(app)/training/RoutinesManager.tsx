"use client";

import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import type { RoutineWithDays } from "@/lib/types";
import { EmptyState } from "@/components/ui";
import ModalShell from "@/components/ModalShell";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import RoutineBuilder from "./RoutineBuilder";
import {
  adoptRoutineTemplateAction,
  activateRoutineAction,
  deactivateRoutineAction,
  deleteRoutineAction,
  restartRoutineCycleAction,
} from "./actions";

// A catalog template summarized for the adopt picker (client-safe subset of
// lib/routine-templates.ts). `dayCount` is the number of distinct days in the
// rotation; the name states the weekly frequency.
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  audience: "beginner" | "intermediate";
  dayCount: number;
}

// A training-scope frequency target that activation would replace, pre-labeled on the
// server so the confirm dialog can list exactly what changes.
export interface ReplaceTarget {
  label: string;
  perWeek: number;
}

function dayCountLabel(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

// The Routines section: list existing routines, adopt a template, author/edit a custom
// routine, and activate/deactivate. Activation replaces the profile's training-scope
// frequency targets (#738 core) — the confirm lists them and appears ONLY when there
// are targets to replace (a fresh profile activates in one tap).
export default function RoutinesManager({
  routines,
  templates,
  replaceTargets,
  liftOptions,
}: {
  routines: RoutineWithDays[];
  templates: TemplateSummary[];
  replaceTargets: ReplaceTarget[];
  liftOptions: string[];
}) {
  // null = closed; { routine? } = builder open (undefined routine → create).
  const [builder, setBuilder] = useState<{ routine?: RoutineWithDays } | null>(
    null
  );
  const [showPicker, setShowPicker] = useState(false);
  // Track the in-flight routine id so its button can show a busy state and can't be
  // double-fired.
  const [busy, setBusy] = useState<number | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  // beginner templates first (onboarding parity, #719), then by name.
  const orderedTemplates = [...templates].sort((a, b) => {
    if (a.audience !== b.audience) return a.audience === "beginner" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  async function callWithId(
    action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>,
    id: number,
    okMsg: string
  ) {
    setBusy(id);
    try {
      const fd = new FormData();
      fd.set("routine_id", String(id));
      const res = await action(fd);
      if (res.ok) toast(okMsg);
      else toast(res.error ?? "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function onActivate(routine: RoutineWithDays) {
    // The confirm only appears when there are training-scope targets to replace; a
    // fresh profile has none, so activation is one tap (#719).
    if (replaceTargets.length > 0) {
      const ok = await confirm({
        title: "Activate this routine?",
        confirmLabel: "Activate",
        message: (
          <div className="space-y-2">
            <p>
              Activating <strong>{routine.name}</strong> replaces your current
              weekly training targets with the ones this routine implies. These
              targets will be replaced:
            </p>
            <ul
              data-testid="replace-targets"
              className="list-disc space-y-0.5 pl-5"
            >
              {replaceTargets.map((t, i) => (
                <li key={i}>
                  {t.label} — {t.perWeek}×/week
                </li>
              ))}
            </ul>
            <p className="text-xs">
              Nutrition targets are untouched. If you deactivate this routine
              later, the derived targets stay as ordinary targets you can edit
              or delete.
            </p>
          </div>
        ),
      });
      if (!ok) return;
    }
    await callWithId(activateRoutineAction, routine.id, "Routine activated");
  }

  async function onDelete(routine: RoutineWithDays) {
    const ok = await confirm({
      title: "Delete routine",
      message: `Delete “${routine.name}”? This can't be undone. Any training targets it set stay in place.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    await callWithId(deleteRoutineAction, routine.id, "Routine deleted");
  }

  return (
    <section
      id="routines"
      data-testid="routines-section"
      className="scroll-mt-[calc(5rem+env(safe-area-inset-top))]"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            Routines
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Adopt a template or build your own. Activating a routine sets your
            weekly training targets; at most one routine is active at a time.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            data-testid="routine-adopt-open"
            onClick={() => setShowPicker(true)}
            className="btn-ghost"
          >
            Adopt a template
          </button>
          <button
            type="button"
            data-testid="routine-new"
            onClick={() => setBuilder({})}
            className="btn inline-flex items-center gap-1.5"
          >
            <IconPlus className="h-4 w-4" /> New routine
          </button>
        </div>
      </div>

      {routines.length === 0 ? (
        <EmptyState message="No routines yet. Adopt a template or build a custom routine to set your weekly training plan." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {routines.map((r) => {
            const active = r.active === 1;
            const isBusy = busy === r.id;
            return (
              <div
                key={r.id}
                data-testid="routine-card"
                className={`card !p-3 text-sm ${
                  active ? "ring-1 ring-brand-400 dark:ring-brand-500" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3
                        data-testid="routine-name-heading"
                        className="font-semibold text-slate-800 dark:text-slate-100"
                      >
                        {r.name}
                      </h3>
                      {active && (
                        <span
                          data-testid="routine-active-badge"
                          className="badge bg-brand-100 text-brand-700 dark:bg-brand-950 dark:text-brand-300"
                        >
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {r.source === "template" ? "From template" : "Custom"} ·{" "}
                      {dayCountLabel(r.days.length)}
                      {r.cycle_weeks != null && (
                        <span> · {r.cycle_weeks}-week cycle</span>
                      )}
                    </div>
                  </div>
                </div>

                <ul className="mt-2 space-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {r.days.map((d) => (
                    <li key={d.id}>
                      <span className="font-medium text-slate-600 dark:text-slate-300">
                        {d.label}
                      </span>
                      {d.focus.length > 0 && (
                        <span> · {d.focus.join(", ")}</span>
                      )}
                      <span className="text-slate-500 dark:text-slate-400">
                        {" "}
                        ({d.slots.length}{" "}
                        {d.slots.length === 1 ? "exercise" : "exercises"})
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="mt-3 flex flex-wrap gap-2">
                  {active ? (
                    <button
                      type="button"
                      data-testid="routine-deactivate"
                      disabled={isBusy}
                      onClick={() =>
                        callWithId(
                          deactivateRoutineAction,
                          r.id,
                          "Routine deactivated"
                        )
                      }
                      className="btn-ghost py-1"
                    >
                      Deactivate
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="routine-activate"
                      disabled={isBusy}
                      onClick={() => onActivate(r)}
                      className="btn py-1"
                    >
                      Activate
                    </button>
                  )}
                  {active && r.cycle_weeks != null && (
                    <button
                      type="button"
                      data-testid="routine-restart-cycle"
                      disabled={isBusy}
                      onClick={() =>
                        callWithId(
                          restartRoutineCycleAction,
                          r.id,
                          "Cycle restarted"
                        )
                      }
                      className="btn-ghost py-1"
                    >
                      Restart cycle
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="routine-edit"
                    onClick={() => setBuilder({ routine: r })}
                    className="btn-ghost py-1"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    data-testid="routine-delete"
                    disabled={isBusy}
                    onClick={() => onDelete(r)}
                    className="btn-ghost py-1 text-rose-600 dark:text-rose-400"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Adopt-a-template picker */}
      {showPicker && (
        <ModalShell
          title="Adopt a template"
          onClose={() => setShowPicker(false)}
        >
          <div className="mt-4 space-y-3" data-testid="template-picker">
            {orderedTemplates.map((t) => (
              <div
                key={t.id}
                data-testid="template-card"
                className="rounded-xl border border-black/10 p-3 dark:border-white/10"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-slate-800 dark:text-slate-100">
                        {t.name}
                      </h3>
                      <span className="badge bg-slate-100 text-slate-500 capitalize dark:bg-slate-800 dark:text-slate-400">
                        {t.audience}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                      {dayCountLabel(t.dayCount)}
                    </div>
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                      {t.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="template-adopt"
                    onClick={async () => {
                      const fd = new FormData();
                      fd.set("template_id", t.id);
                      const res = await adoptRoutineTemplateAction(fd);
                      if (res.ok) {
                        toast(`Adopted ${t.name}`);
                        setShowPicker(false);
                      } else {
                        toast(res.error ?? "Couldn't adopt this template");
                      }
                    }}
                    className="btn shrink-0 py-1"
                  >
                    Adopt
                  </button>
                </div>
              </div>
            ))}
          </div>
        </ModalShell>
      )}

      {/* Custom builder / edit */}
      {builder && (
        <ModalShell
          title={builder.routine ? "Edit routine" : "New routine"}
          onClose={() => setBuilder(null)}
        >
          <RoutineBuilder
            liftOptions={liftOptions}
            editRoutine={builder.routine}
            onDone={() => setBuilder(null)}
          />
        </ModalShell>
      )}
    </section>
  );
}
