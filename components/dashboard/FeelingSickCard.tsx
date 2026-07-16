"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import WidgetHeader from "@/components/dashboard/WidgetHeader";
import { activateIllnessForSymptoms } from "@/app/(app)/symptoms/actions";

// The illness "first hour" front door (issue #843, door A). The dashboard Symptoms
// widget used to render `null` until an illness-type situation was already active — so
// the moment you FIRST feel sick, the one surface built for it wasn't there. Its
// inactive state is now a single, calm affordance instead: one line that sits quietly
// 95% of the year, and ONE tap that activates the built-in "Illness" situation AND
// reveals the full symptom card (symptoms + temperature + time) via the page's
// re-render. Explicit tap, never auto-activation (the #560 bridge discipline) — this
// is the reverse of the same suggest-only bridge SymptomLogBar offers on the Timeline.
// A widget state, not a Finding: it stays hideable from Customize like any other widget.
export default function FeelingSickCard() {
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="card" data-testid="feeling-sick-card">
      <WidgetHeader title="Symptoms" href="/timeline" linkLabel="Timeline" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Feeling sick? Start tracking symptoms and temperature.
        </p>
        <button
          type="button"
          data-testid="feeling-sick-activate"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await activateIllnessForSymptoms();
              router.refresh();
            })
          }
          className="badge cursor-pointer border border-dashed border-brand-400 bg-transparent text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-brand-700 dark:text-brand-300 dark:hover:bg-brand-950"
        >
          {pending ? "Starting…" : "I'm feeling sick"}
        </button>
      </div>
    </div>
  );
}
