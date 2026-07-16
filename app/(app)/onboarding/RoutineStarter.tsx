"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconBarbell, IconCheck } from "@tabler/icons-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import {
  startOnboardingRoutine,
  type OnboardingRoutineResult,
} from "./actions";

export interface StarterRoutineTemplate {
  id: string;
  name: string;
  description: string;
  dayCount: number;
}

interface ReplaceTarget {
  label: string;
  perWeek: number;
}

export default function RoutineStarter({
  templates,
  replaceTargets,
  activeRoutineName,
  readOnly,
}: {
  templates: StarterRoutineTemplate[];
  replaceTargets: ReplaceTarget[];
  activeRoutineName: string | null;
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const router = useRouter();

  async function chooseRoutine(template: StarterRoutineTemplate) {
    let confirmed = false;
    if (replaceTargets.length > 0) {
      confirmed = await confirm({
        title: "Use this routine?",
        confirmLabel: "Use routine",
        message: (
          <div className="space-y-2">
            <p>
              Using <strong>{template.name}</strong> replaces these current
              weekly training targets:
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {replaceTargets.map((target) => (
                <li key={`${target.label}-${target.perWeek}`}>
                  {target.label} — {target.perWeek}×/week
                </li>
              ))}
            </ul>
            <p className="text-xs">
              Nutrition targets are untouched. You can edit or replace the
              routine later in Training.
            </p>
          </div>
        ),
      });
      if (!confirmed) return;
    }

    setBusy(template.id);
    const formData = new FormData();
    formData.set("template_id", template.id);
    if (confirmed) formData.set("confirm_replace", "yes");
    let result: OnboardingRoutineResult;
    try {
      result = await startOnboardingRoutine(formData);
    } finally {
      setBusy(null);
    }
    if (!result.ok) {
      toast(result.error);
      if (result.needsConfirmation) router.refresh();
      return;
    }
    toast(`${result.routineName} is ready`);
    router.push("/onboarding?step=5");
  }

  return (
    <div
      data-testid="onboarding-routine-starter"
      className="mb-5 rounded-xl border border-black/10 p-4 dark:border-white/10"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-ink-850 dark:text-slate-300">
          <IconBarbell className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            Start with a simple routine
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Get complete sets and rep ranges from day one. Suggested weights and
            progress trends improve after you log each lift.
          </p>
        </div>
      </div>

      {activeRoutineName ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 dark:bg-emerald-500/10">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
            <IconCheck className="h-4 w-4" aria-hidden="true" />
            {activeRoutineName} is active
          </span>
          <Link
            href="/training?tab=routines"
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            Manage routines
          </Link>
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {templates.map((template) => (
            <div
              key={template.id}
              data-testid="onboarding-routine-template"
              className="flex flex-col rounded-lg bg-slate-50 p-3 dark:bg-ink-850"
            >
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                {template.name}
              </div>
              <div className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                {template.dayCount} days in the rotation
              </div>
              <p className="mt-2 flex-1 text-xs text-slate-500 dark:text-slate-400">
                {template.description}
              </p>
              {!readOnly && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void chooseRoutine(template)}
                  className="btn-ghost mt-3 w-full text-xs"
                >
                  {busy === template.id
                    ? "Setting up…"
                    : `Use ${template.name}`}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
