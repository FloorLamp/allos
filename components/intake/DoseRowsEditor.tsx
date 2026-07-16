"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconX } from "@tabler/icons-react";
import {
  TIME_BUCKETS,
  FOOD_TIMINGS,
  FOOD_TIMING_LABELS,
} from "@/lib/supplement-schedule";
import type { FoodTiming } from "@/lib/types";

// One editable dose row's client state (shared by both intake forms, #846).
export interface DoseState {
  id?: number;
  amount: string;
  time_of_day: string;
  food_timing: FoodTiming;
}

export const emptyDose = (): DoseState => ({
  amount: "",
  time_of_day: "",
  food_timing: "any",
});

// The dose-rows editor shared by both intake forms (#846): one or more amount /
// time-of-day / food-timing rows with add + remove. `dosageOptions` feeds a datalist
// of amount suggestions — the supplement catalog's dosages for a supplement, the OTC
// label strengths for a medication (each form supplies its own source; the editor is
// kind-blind). `datalistId` is unique per form so multiple forms on a page don't
// collide.
export default function DoseRowsEditor({
  doses,
  setDoses,
  dosageOptions,
  datalistId,
  amountPlaceholder = "amount",
}: {
  doses: DoseState[];
  setDoses: Dispatch<SetStateAction<DoseState[]>>;
  dosageOptions: string[];
  datalistId: string;
  amountPlaceholder?: string;
}) {
  function setDose(i: number, patch: Partial<DoseState>) {
    setDoses((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  return (
    <div className="sm:col-span-2">
      <label className="label">Doses</label>
      <datalist id={datalistId}>
        {dosageOptions.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div className="space-y-2">
        {doses.map((d, i) => (
          <div
            key={i}
            className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
          >
            <input
              list={datalistId}
              value={d.amount}
              onChange={(e) => setDose(i, { amount: e.target.value })}
              className="input sm:w-28"
              placeholder={amountPlaceholder}
              aria-label="Amount"
            />
            <select
              value={d.time_of_day || "Anytime"}
              onChange={(e) => setDose(i, { time_of_day: e.target.value })}
              className="input sm:w-32"
              aria-label="Time of day"
            >
              {TIME_BUCKETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select
              value={d.food_timing}
              onChange={(e) =>
                setDose(i, { food_timing: e.target.value as FoodTiming })
              }
              className="input col-span-2 sm:col-auto sm:w-40"
              aria-label="Food timing"
            >
              {FOOD_TIMINGS.map((ft) => (
                <option key={ft} value={ft}>
                  {FOOD_TIMING_LABELS[ft]}
                </option>
              ))}
            </select>
            {doses.length > 1 && (
              <button
                type="button"
                onClick={() => setDoses((ds) => ds.filter((_, j) => j !== i))}
                className="tap-target col-span-2 flex h-8 w-8 items-center justify-center justify-self-end rounded text-slate-300 hover:text-rose-500 sm:col-auto dark:text-slate-600 dark:hover:text-rose-400"
                aria-label="Remove dose"
              >
                <IconX className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setDoses((ds) => [...ds, emptyDose()])}
        className="mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-400"
      >
        + Add dose (split across times)
      </button>
    </div>
  );
}
