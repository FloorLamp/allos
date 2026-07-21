"use client";

import type { Dispatch, SetStateAction } from "react";
import { IconPlus, IconX } from "@tabler/icons-react";
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
  singleAmountOnly = false,
}: {
  doses: DoseState[];
  setDoses: Dispatch<SetStateAction<DoseState[]>>;
  dosageOptions: string[];
  datalistId: string;
  amountPlaceholder?: string;
  // PRN ⇒ amount-only mode (#851 item 9): a PRN medication carries exactly ONE
  // amount-only dose (plus its with-food relation) — no time-of-day slots, no split,
  // no add/remove — because the redose interval owns "when". A no-op for the scheduled
  // supplement/medication editor, which keeps the full slot + split affordances.
  singleAmountOnly?: boolean;
}) {
  function setDose(i: number, patch: Partial<DoseState>) {
    setDoses((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }

  if (singleAmountOnly) {
    const d = doses[0] ?? emptyDose();
    return (
      <div className="sm:col-span-2" data-testid="prn-dose-row">
        <div className="mb-2 section-label">Dose</div>
        <datalist id={datalistId}>
          {dosageOptions.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            list={datalistId}
            value={d.amount}
            onChange={(e) =>
              setDoses((ds) => {
                const first = ds[0] ?? emptyDose();
                return [{ ...first, amount: e.target.value, time_of_day: "" }];
              })
            }
            className="input"
            placeholder={amountPlaceholder}
            aria-label="Amount"
          />
          <select
            value={d.food_timing}
            onChange={(e) =>
              setDoses((ds) => {
                const first = ds[0] ?? emptyDose();
                return [
                  {
                    ...first,
                    food_timing: e.target.value as FoodTiming,
                    time_of_day: "",
                  },
                ];
              })
            }
            className="input"
            aria-label="Food timing"
          >
            {FOOD_TIMINGS.map((ft) => (
              <option key={ft} value={ft}>
                {FOOD_TIMING_LABELS[ft]}
              </option>
            ))}
          </select>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          As-needed doses have no set time — the redose reminder covers “when”.
        </p>
      </div>
    );
  }

  return (
    <div className="sm:col-span-2">
      <div className="mb-2 section-label">Doses</div>
      <datalist id={datalistId}>
        {dosageOptions.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div className="space-y-2">
        {doses.map((d, i) => (
          <div
            key={i}
            className={`grid gap-2 sm:items-center ${
              doses.length > 1
                ? "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)_2.5rem]"
                : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)]"
            }`}
          >
            <input
              list={datalistId}
              value={d.amount}
              onChange={(e) => setDose(i, { amount: e.target.value })}
              className="input"
              placeholder={amountPlaceholder}
              aria-label="Amount"
            />
            <select
              value={d.time_of_day || "Anytime"}
              onChange={(e) => setDose(i, { time_of_day: e.target.value })}
              className="input"
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
              className="input"
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
                className="tap-target flex h-10 w-10 items-center justify-center justify-self-end rounded-lg text-slate-500 transition hover:bg-rose-50 hover:text-rose-600 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
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
        className="btn-ghost btn-sm mt-2"
      >
        <IconPlus className="h-4 w-4" stroke={2} aria-hidden="true" />
        Add dose
      </button>
    </div>
  );
}
