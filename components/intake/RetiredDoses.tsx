"use client";

import { useState } from "react";
import type { SupplementDose } from "@/lib/types";
import { parseWeekdays, doseCadenceLabel } from "@/lib/intake-cadence";
import { restoreDose } from "@/app/(app)/nutrition/supplement-actions";
import type { DoseState } from "./DoseRowsEditor";

// The RETIRED doses of the item being edited, each with its Restore affordance
// (#2131 — the equipment "archived + restore" pattern applied to the one lifecycle
// that had no reopen). RENDERED FROM STATE per the stateful-affordances doctrine: a
// row appears here only because it IS retired, and the label names the write the tap
// performs. The write core can still refuse (already restored elsewhere, a live dose
// now covering the slot), and that typed refusal is rendered inline — never an
// unconditional confirm.
//
// On success the restored dose is handed to the parent form so its dose rows include
// the row (with its ORIGINAL id — the whole point of retire-not-delete, #2000): a
// subsequent Save keeps it instead of re-retiring it as "removed".
export default function RetiredDoses({
  doses: initialDoses,
  onRestored,
}: {
  doses: SupplementDose[];
  onRestored: (dose: DoseState & { id: number }) => void;
}) {
  const [doses, setDoses] = useState(initialDoses);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  if (doses.length === 0) return null;
  return (
    <div className="sm:col-span-2" data-testid="retired-doses">
      <div className="mb-1 section-label">Retired doses</div>
      <p className="mb-2 text-xs text-slate-500 dark:text-slate-400">
        Removed from the schedule but kept for their logged history. Restoring
        puts a dose back on the schedule from today — its past days stay exactly
        as recorded.
      </p>
      <ul className="divide-y divide-black/5 border-y border-black/5 dark:divide-white/5 dark:border-white/5">
        {doses.map((d) => {
          const cadence = doseCadenceLabel({
            weekdays: d.weekdays ?? null,
            start_date: d.start_date ?? null,
            end_date: d.end_date ?? null,
          });
          return (
            <li
              key={d.id}
              className="flex items-center justify-between gap-2 py-1.5"
            >
              <span className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
                {[d.amount, d.time_of_day, cadence]
                  .filter(Boolean)
                  .join(" · ") || "Dose"}
              </span>
              <button
                type="button"
                className="btn-ghost btn-sm shrink-0"
                data-testid={`restore-dose-${d.id}`}
                disabled={busyId === d.id}
                onClick={async () => {
                  setError(null);
                  setBusyId(d.id);
                  try {
                    const fd = new FormData();
                    fd.set("dose_id", String(d.id));
                    const res = await restoreDose(fd);
                    if (!res.ok) {
                      setError(res.error);
                      return;
                    }
                    setDoses((ds) => ds.filter((x) => x.id !== d.id));
                    onRestored({
                      id: res.dose.id,
                      amount: res.dose.amount ?? "",
                      time_of_day: res.dose.time_of_day ?? "",
                      food_timing: res.dose.food_timing,
                      weekdays: [...parseWeekdays(res.dose.weekdays)].sort(
                        (a, b) => a - b
                      ),
                      start_date: res.dose.start_date ?? "",
                      end_date: res.dose.end_date ?? "",
                    });
                  } finally {
                    setBusyId(null);
                  }
                }}
              >
                Restore to schedule
              </button>
            </li>
          );
        })}
      </ul>
      {error && (
        <p
          role="alert"
          data-testid="retired-doses-error"
          className="mt-1 text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}
    </div>
  );
}
